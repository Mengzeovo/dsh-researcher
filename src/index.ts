/** Host researcher service: project-file authority, session binding, and Goal activation. */

import type { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import {
  buildResearchContext,
  createResearchContextMessage,
  markerResearchId,
  researchBindingFromMessage,
  researchGoalObjective,
} from './context.ts'
import { ResearcherError } from './errors.ts'
import { nowIso, parseResearchId, researchBindingSchema, researchTargetListRequestSchema } from './schema.ts'
import { ResearchStore } from './research-store.ts'
import type {
  CreateResearchRequest,
  FinishResearchRunRequest,
  ResearchBinding,
  ResearchCreateResult,
  ResearchGlossaryPatch,
  ResearchGlossaryResult,
  ResearchId,
  ResearchLoadResult,
  ResearchReadResult,
  ResearchRunFinishResult,
  ResearchRunStartResult,
  ResearchStateResult,
  ResearchTargetList,
  ResearchTargetListRequest,
  ResearchTargetSnapshot,
  StartResearchRunRequest,
  UpdateResearchRequest,
} from './types.ts'

export interface ResearcherBindingProjectionState {
  readonly bindings: Readonly<Record<string, ResearchBinding>>
  readonly failure: string | null
}

const researcherBindingProjectionSchema: z.ZodType<ResearcherBindingProjectionState> = z.object({
  bindings: z.record(z.string(), researchBindingSchema).superRefine((bindings, ctx) => {
    for (const [sessionId, binding] of Object.entries(bindings)) {
      if (binding.sessionId !== sessionId) {
        ctx.addIssue({ code: 'custom', path: [sessionId], message: 'binding key does not match sessionId' })
      }
    }
  }),
  failure: z.string().min(1).nullable(),
}).strict()

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    researcherBinding: ResearcherBindingProjectionState
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    researcher: ResearcherService
  }
}

export function applyResearcherBindingProjection(
  state: ResearcherBindingProjectionState,
  event: import('@deepseek-ai/dsh-session').SessionEvent,
): ResearcherBindingProjectionState {
  if (state.failure !== null || event.type !== 'agent/inbox/spliced') return state
  let next = state
  for (const message of event.data.inserted) {
    let binding: ResearchBinding | undefined
    try {
      binding = researchBindingFromMessage(message)
    } catch (error) {
      return {
        ...state,
        failure: `researcher binding replay failed at event ${event.seq}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (binding === undefined) continue
    const existing = next.bindings[binding.sessionId]
    if (existing !== undefined && existing.researchId !== binding.researchId) {
      return {
        ...state,
        failure: `researcher binding replay found conflicting ids ${existing.researchId} and ${binding.researchId} for session ${binding.sessionId} at event ${event.seq}`,
      }
    }
    next = {
      bindings: { ...next.bindings, [binding.sessionId]: binding },
      failure: null,
    }
  }
  return next
}

export const researcherBindingProjectionDefinition = {
  key: 'researcherBinding',
  stateVersion: 1,
  stateSchema: researcherBindingProjectionSchema,
  init: (): ResearcherBindingProjectionState => ({ bindings: {}, failure: null }),
  apply: applyResearcherBindingProjection,
} satisfies ProjectionDefinition<'researcherBinding', ResearcherBindingProjectionState>

function goalRef(goal: GoalView): { id: GoalView['id']; revision: number } {
  return { id: goal.id, revision: goal.revision }
}

function goalMarkerMatches(goal: GoalView, id: ResearchId): boolean {
  return markerResearchId(goal.objective) === id
}

class SerialGate {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

export class ResearcherService extends TypertRemoteService {
  static inject = ['agents', 'fs', 'goals', 'sandbox', 'sandboxPolicy', 'sessionProjections', 'subprocess']

  private readonly store: ResearchStore
  private readonly activationGates = new WeakMap<Session, SerialGate>()

  constructor(ctx: Context) {
    super(ctx, 'researcher')
    this.store = new ResearchStore(ctx)
    ctx.sessionProjections.register(researcherBindingProjectionDefinition)
  }

  binding(session: Session): ResearchBinding | undefined {
    const state = this.ctx.sessionProjections.stateOf(session, 'researcherBinding')
    if (state === undefined) throw new ResearcherError('researcher binding projection is not registered', 'RESEARCH_INVALID_RECORD')
    if (state.failure !== null) throw new ResearcherError(state.failure, 'RESEARCH_INVALID_RECORD')
    return state.bindings[String(session.id)]
  }

  async list(request: ResearchTargetListRequest, signal?: AbortSignal): Promise<ResearchTargetList> {
    const parsed = researchTargetListRequestSchema.parse(request)
    try {
      const agent = this.ctx.agents.get(SessionId(parsed.sessionId))
      if (agent === undefined) {
        throw new ResearcherError(`session ${parsed.sessionId} is not a live agent`, 'RESEARCH_SESSION_NOT_LIVE')
      }
      const listed = await this.store.listTargets(agent.session, signal)
      const binding = this.binding(agent.session)
      return {
        version: 1,
        ...(binding === undefined ? {} : { boundResearchId: binding.researchId }),
        targets: listed.targets,
        invalid: listed.invalid,
      }
    } catch (error) {
      if (error instanceof ResearcherError) {
        throw new RemoteError('researcher/domain', error.message, { code: error.code }, { cause: error })
      }
      throw error
    }
  }

  async get(agent: Agent, signal?: AbortSignal): Promise<ResearchReadResult> {
    const binding = this.requireBinding(agent.session)
    const target = await this.store.readTarget(agent.session, binding.researchId, signal)
    return {
      researchId: binding.researchId,
      target,
      context: buildResearchContext(target, binding),
    }
  }

  async create(
    agent: Agent,
    request: CreateResearchRequest,
    signal?: AbortSignal,
  ): Promise<ResearchCreateResult> {
    return await this.activationGate(agent.session).run(async () => {
      this.assertCreateCompatible(agent)
      const target = await this.store.createTarget(agent.session, request, signal)
      try {
        const loaded = await this.activate(agent, target, signal)
        return { ...loaded, created: true }
      } catch (error) {
        throw new ResearcherError(
          `research target ${target.id} was committed but activation failed; recover with /research-load ${target.id}`,
          error instanceof ResearcherError ? error.code : 'RESEARCH_GOAL_CONFLICT',
          { cause: error },
        )
      }
    })
  }

  async load(
    agent: Agent,
    idInput: ResearchId | string,
    signal?: AbortSignal,
  ): Promise<ResearchLoadResult> {
    const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput
    return await this.activationGate(agent.session).run(async () => {
      this.assertBindingCompatible(agent.session, id)
      const target = await this.store.readTarget(agent.session, id, signal)
      return await this.activate(agent, target, signal)
    })
  }

  async updateState(agent: Agent, request: UpdateResearchRequest, signal?: AbortSignal): Promise<ResearchStateResult> {
    const binding = this.requireBinding(agent.session)
    return await this.store.appendState(agent.session, binding.researchId, request, signal)
  }

  async startRun(agent: Agent, request: StartResearchRunRequest, signal?: AbortSignal): Promise<ResearchRunStartResult> {
    const binding = this.requireBinding(agent.session)
    return await this.store.startRun(agent.session, binding.researchId, request, signal)
  }

  async finishRun(agent: Agent, request: FinishResearchRunRequest, signal?: AbortSignal): Promise<ResearchRunFinishResult> {
    const binding = this.requireBinding(agent.session)
    return await this.store.finishRun(agent.session, binding.researchId, request, signal)
  }

  async updateGlossary(
    agent: Agent,
    patch: ResearchGlossaryPatch,
    signal?: AbortSignal,
  ): Promise<ResearchGlossaryResult> {
    const binding = this.requireBinding(agent.session)
    return await this.store.updateGlossary(agent.session, binding.researchId, patch, signal)
  }

  private async activate(
    agent: Agent,
    initialTarget: ResearchTargetSnapshot,
    signal?: AbortSignal,
  ): Promise<ResearchLoadResult> {
    this.assertBindingCompatible(agent.session, initialTarget.id)
    this.assertGoalCompatible(agent, initialTarget.id)
    if (initialTarget.recovery === undefined) this.assertGoalActivationCapacity(agent, initialTarget)
    const target = initialTarget.recovery === undefined
      && (initialTarget.state.status === 'paused' || initialTarget.state.status === 'blocked')
      ? await this.store.resumeState(agent.session, initialTarget.id, signal)
      : initialTarget
    const loadedAt = nowIso()
    const binding = researchBindingSchema.parse({
      version: 1,
      researchId: target.id,
      sessionId: String(agent.session.id),
      loadedAt,
    })
    const context = buildResearchContext(target, binding)
    const message = createResearchContextMessage(context)
    await this.store.bindSession(agent.session, target.id, loadedAt, signal)
    const eventSeq = agent.session.events.length
    agent.inject(message)
    const event = agent.session.events[eventSeq]
    if (event?.type !== 'agent/inbox/spliced'
      || !event.data.inserted.some(inserted => researchBindingFromMessage(inserted)?.researchId === target.id)) {
      throw new ResearcherError('researcher context injection did not produce the expected durable inbox event', 'RESEARCH_INVALID_RECORD')
    }
    let goalAction: ResearchLoadResult['goalAction']
    try {
      // Recovery binds a session but never edits frozen state or changes an existing Goal.
      goalAction = target.recovery === undefined ? this.applyGoalActivation(agent, target) : 'recovery-only'
    } catch (error) {
      throw new ResearcherError(
        `research target ${target.id} was loaded and injected, but its DSH Goal could not be activated; retry /research-load ${target.id}`,
        'RESEARCH_GOAL_CONFLICT',
        { cause: error },
      )
    }
    return { researchId: target.id, eventSeq: event.seq, target, context, goalAction }
  }

  private assertCreateCompatible(agent: Agent): void {
    if (this.binding(agent.session) !== undefined) {
      throw new ResearcherError('this DSH session is already bound to a research target', 'RESEARCH_SESSION_BOUND')
    }
    const goal = this.ctx.goals.get(agent)
    if (goal !== undefined && goal.phase !== 'complete') {
      throw new ResearcherError(
        'an unfinished DSH Goal already owns this session; complete or clear it before creating a research target',
        'RESEARCH_GOAL_CONFLICT',
      )
    }
  }

  private assertBindingCompatible(session: Session, id: ResearchId): void {
    const binding = this.binding(session)
    if (binding !== undefined && binding.researchId !== id) {
      throw new ResearcherError(
        `this DSH session is already bound to research target ${binding.researchId}`,
        'RESEARCH_SESSION_BOUND',
      )
    }
  }

  private assertGoalCompatible(agent: Agent, id: ResearchId): void {
    const goal = this.ctx.goals.get(agent)
    if (goal === undefined || goal.phase === 'complete' || goalMarkerMatches(goal, id)) return
    throw new ResearcherError(
      'a different unfinished DSH Goal already owns this session; researcher will not replace it silently',
      'RESEARCH_GOAL_CONFLICT',
    )
  }

  private assertGoalActivationCapacity(agent: Agent, target: ResearchTargetSnapshot): void {
    if (target.state.status === 'complete') return
    const goal = this.ctx.goals.get(agent)
    if (goal === undefined || goal.phase === 'complete') return
    const needsResume = goal.phase !== 'active' || goal.activation !== 'armed'
    if (needsResume && goal.roundsStarted >= goal.maxGoalRounds) {
      throw new ResearcherError(
        `DSH Goal ${goal.id} exhausted its ${goal.maxGoalRounds} automatic rounds before researcher activation`,
        'RESEARCH_GOAL_CONFLICT',
      )
    }
  }

  private activationGate(session: Session): SerialGate {
    const existing = this.activationGates.get(session)
    if (existing !== undefined) return existing
    const created = new SerialGate()
    this.activationGates.set(session, created)
    return created
  }

  private applyGoalActivation(agent: Agent, target: ResearchTargetSnapshot): ResearchLoadResult['goalAction'] {
    const current = this.ctx.goals.get(agent)
    if (target.state.status === 'complete') {
      if (current !== undefined && current.phase !== 'complete' && goalMarkerMatches(current, target.id)) {
        this.ctx.goals.complete(agent, goalRef(current))
        return 'completed'
      }
      return 'view-only'
    }
    const objective = researchGoalObjective(target)
    if (current === undefined || current.phase === 'complete') {
      this.ctx.goals.create(agent, { objective })
      return 'created'
    }
    if (!goalMarkerMatches(current, target.id)) {
      throw new ResearcherError('current DSH Goal marker does not match the loaded target', 'RESEARCH_GOAL_CONFLICT')
    }
    let latest = current
    let edited = false
    if (latest.objective !== objective) {
      latest = this.ctx.goals.edit(agent, goalRef(latest), { objective })
      edited = true
    }
    if (latest.phase !== 'active' || latest.activation !== 'armed') {
      this.ctx.goals.resume(agent, goalRef(latest))
      return 'resumed'
    }
    return edited ? 'updated' : 'unchanged'
  }

  private requireBinding(session: Session): ResearchBinding {
    const binding = this.binding(session)
    if (binding === undefined) {
      throw new ResearcherError('no research target is loaded in this DSH session', 'RESEARCH_NOT_FOUND')
    }
    return binding
  }
}

export const name = 'researcher'
export const inject = ResearcherService.inject
export default ResearcherService

export type {
  ResearchRecovery,
  CreateResearchRequest,
  FinishResearchRunRequest,
  ResearchBinding,
  ResearchCreateResult,
  ResearchGlossaryPatch,
  ResearchGlossaryResult,
  ResearchId,
  ResearchLoadResult,
  ResearchReadResult,
  ResearchRunFinishResult,
  ResearchRunStartResult,
  ResearchStateResult,
  ResearchTargetList,
  ResearchTargetListRequest,
  StartResearchRunRequest,
  UpdateResearchRequest,
} from './types.ts'
export { ResearcherError } from './errors.ts'
