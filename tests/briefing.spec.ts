import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import GoalService, { GoalId } from '@deepseek-ai/dsh-goal'
import * as GoalDriver from '@deepseek-ai/dsh-goal-round-driver'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { ResearchBriefings } from '../src/briefing.ts'
import { ResearcherService, researcherBindingProjectionDefinition } from '../src/index.ts'
import { parseGoalMarkdown, parseResearchId, renderGoalMarkdown } from '../src/schema.ts'
import type { ResearchTargetSnapshot } from '../src/types.ts'

const SOURCE = 'dsh-profile-researcher:briefing'
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
})

function text(text = '目标与现状已加载；建议先确认方案，等待你的下一步要求。'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function call(name: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** A non-executing CodeRuntime provider for exercising the real PTC transport fence. */
class DisabledCodeRuntime extends Service {
  readonly language = 'typescript'
  readonly isolation = 'fake'
  readonly run = vi.fn(async () => { throw new Error('Briefing must never enter a code runtime') })
  constructor(ctx: Context) { super(ctx, 'codeRuntime') }
}

type Script = StreamChunk[] | ((request: GenerateOptions) => Promise<StreamChunk[]> | StreamChunk[])
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: Script[]) { super() }
  override async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('Unexpected extra model request')
    const chunks = typeof entry === 'function' ? await entry(request) : entry
    for (const chunk of chunks) yield chunk
  }
}

function human(value: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } })
}
function notice(value: string, plugin = 'test-context'): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'plugin', plugin } })
}
function requestText(request: GenerateOptions): string {
  return request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
}
function aborting(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Canceled test stream')); return }
    signal?.addEventListener('abort', () => { reject(new Error('Canceled test stream')) }, { once: true })
  })
}

async function harness(script: Script[], pausedGoal = false, mode: 'native' | 'both' = 'native', withGoals = true) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode })
  if (mode === 'both') await ctx.plugin(DisabledCodeRuntime)
  await ctx.plugin(AgentRegistry)
  if (withGoals) await ctx.plugin(GoalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['briefing-test'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'briefing-test', model: 'fake' })
  if (pausedGoal) {
    const goal = ctx.goals.create(agent, { objective: 'Existing unrelated execution state' })
    ctx.goals.pause(agent, { id: goal.id, revision: goal.revision })
  }
  const goalDriver = withGoals ? await ctx.plugin(GoalDriver) : undefined
  let briefings!: ResearchBriefings
  const owner = await ctx.plugin({
    name: 'briefing-test-owner',
    inject: ['agents'],
    apply(scope: Context) { briefings = new ResearchBriefings(scope) },
  })
  const execute = vi.fn(async () => [{ type: 'text' as const, text: 'Tool executed' }])
  for (const name of ['bash', 'write', 'custom_tool']) {
    ctx.tools.register(defineContentToolFixture({ name, description: 'Test forbidden execution', parameters: {}, execute }))
  }
  const queue = () => {
    agent.inject(notice('Recorded research: paused; selected plan 2 revision 4; next direction needs user confirmation.'))
    briefings.queue(agent)
  }
  return { ctx, agent, adapter, briefings, owner, execute, queue, goalDriver }
}

function serviceFor(h: Awaited<ReturnType<typeof harness>>) {
  h.ctx.sessionProjections.register(researcherBindingProjectionDefinition)
  const id = parseResearchId('123e4567-e89b-42d3-a456-426614174000')
  const target: ResearchTargetSnapshot = {
    id, root: '.research/goal/' + id, goalPath: '.research/goal/' + id + '/goal.md',
    goal: parseGoalMarkdown(renderGoalMarkdown('Discuss feedback adaptation.', ['verified progress'], 'baseline')),
    state: { version: 1, revision: 1, at: '2026-03-01T00:00:00.000Z', sessionId: 'prior', status: 'active', summary: 'Existing proposal' },
    glossary: { version: 1, terms: {}, files: {} }, warnings: [],
  }
  const store = {
    canonicalWorkspace: vi.fn(async () => '/workspace'), readTarget: vi.fn(async () => target),
    bindSession: vi.fn(async () => {}),
  }
  const service = Object.create(ResearcherService.prototype) as ResearcherService
  Object.defineProperties(service, {
    ctx: { value: h.ctx }, store: { value: store }, briefings: { value: h.briefings },
    activationGates: { value: new WeakMap() }, loadingSessions: { value: new WeakSet() },
  })
  return { service, target }
}

function stepCount(agent: Agent, turn?: number): number {
  return agent.session.snapshotEvents().filter(event => event.type === 'step/start' && (turn === undefined || event.data.turn === turn)).length
}

describe('ResearchBriefings real agent-loop and Goal driver', () => {
  it.each(['active', 'paused', 'blocked', 'complete'] as const)(
    'actual service.load binds a %s target and briefs once without changing research state or creating a Goal', async status => {
      const h = await harness([text()])
      h.ctx.sessionProjections.register(researcherBindingProjectionDefinition)
      const id = parseResearchId('123e4567-e89b-42d3-a456-426614174000')
      const target: ResearchTargetSnapshot = {
        id, root: `.research/goal/${id}`, goalPath: `.research/goal/${id}/goal.md`,
        goal: parseGoalMarkdown(renderGoalMarkdown('Investigate feedback adaptation.', ['verified improvement'], 'existing baseline')),
        state: { version: 1, revision: 3, at: '2026-03-01T00:00:00.000Z', sessionId: 'prior-session', status,
          summary: 'Feedback assumptions need confirmation', next: 'Discuss the existing proposal with the user' },
        glossary: { version: 1, terms: {}, files: {} }, warnings: [],
      }
      const before = structuredClone(target)
      const store = {
        canonicalWorkspace: vi.fn(async () => '/workspace'), readTarget: vi.fn(async () => target),
        bindSession: vi.fn(async () => {}), resumeState: vi.fn(() => { throw new Error('Load must not resume research') }),
      }
      const service = Object.create(ResearcherService.prototype) as ResearcherService
      Object.defineProperties(service, {
        ctx: { value: h.ctx }, store: { value: store }, briefings: { value: h.briefings },
        activationGates: { value: new WeakMap() }, loadingSessions: { value: new WeakSet() },
      })
      const loaded = await service.load(h.agent, id)
      await h.agent.whenIdle()
      expect(loaded).toMatchObject({ mode: 'context-only', goalAction: 'unchanged', briefing: 'queued' })
      expect(service.binding(h.agent.session)?.researchId).toBe(id)
      expect(store.bindSession).toHaveBeenCalledOnce()
      expect(store.resumeState).not.toHaveBeenCalled()
      expect(target).toEqual(before)
      expect(h.ctx.goals.get(h.agent)).toBeUndefined()
      expect(h.adapter.requests).toHaveLength(1)
      expect(stepCount(h.agent)).toBe(1)
      expect(h.adapter.requests[0]?.tools ?? []).toEqual([])
      expect(requestText(h.adapter.requests[0]!)).toContain('Feedback assumptions need confirmation')
      expect(h.execute).not.toHaveBeenCalled()
    },
  )

  it('briefs once from injected context with plugin authority and restores tools for a later human turn', async () => {
    const h = await harness([text(), text('Normal human response')])
    h.queue()
    expect(h.briefings.busy(h.agent)).toBe(true)
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(1)
    expect(h.adapter.requests[0]?.tools ?? []).toEqual([])
    expect(requestText(h.adapter.requests[0]!)).toContain('selected plan 2 revision 4')
    expect(requestText(h.adapter.requests[0]!)).toContain('context-only briefing')
    const inputs = h.agent.session.snapshotEvents().filter(event => event.type === 'user/message')
    expect(inputs.every(event => event.data.source.kind !== 'user' && event.data.source.kind !== 'goal')).toBe(true)
    expect(inputs.some(event => event.data.source.kind === 'plugin' && event.data.source.plugin === SOURCE)).toBe(true)
    expect(stepCount(h.agent)).toBe(1)
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.ctx.goals.get(h.agent)).toBeUndefined()
    expect(h.briefings.busy(h.agent)).toBe(false)
    h.agent.followup(human('Now explain the proposal.'))
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
    expect(h.adapter.requests[1]?.tools?.map(tool => tool.name)).toContain('bash')
  })

  it('does not activate a paused Goal or create an automatic Goal round', async () => {
    const h = await harness([text()], true)
    const before = h.ctx.goals.get(h.agent)
    h.queue()
    await h.agent.whenIdle()
    expect(h.ctx.goals.get(h.agent)).toEqual(before)
    expect(h.ctx.goals.get(h.agent)).toMatchObject({ phase: 'paused', activation: 'disarmed', roundsStarted: 0 })
    expect(h.adapter.requests).toHaveLength(1)
    expect(h.agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
  })

  it.each(['bash', 'write', 'custom_tool', 'run_code', 'unregistered_tool'])(
    'blocks model-requested %s, executes nothing and terminates with a diagnostic before a second step', async name => {
      const h = await harness([call(name)])
      h.queue()
      await h.agent.whenIdle()
      expect(h.execute).not.toHaveBeenCalled()
      expect(h.adapter.requests).toHaveLength(1)
      expect(stepCount(h.agent)).toBe(1)
      expect(h.briefings.busy(h.agent)).toBe(false)
      const ending = h.agent.session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(ending).toMatchObject({ data: { reason: { kind: 'error', error: { message: expect.stringContaining('context-only load does not allow tool calls') } } } })
    },
  )

  it('blocks the real run_code presentation transport before any program execution', async () => {
    const h = await harness([call('run_code')], false, 'both')
    h.queue()
    await h.agent.whenIdle()
    expect(h.adapter.requests[0]?.tools ?? []).toEqual([])
    expect(h.adapter.requests, JSON.stringify(h.agent.session.snapshotEvents().filter(event => event.type === 'turn/end'))).toHaveLength(1)
    expect(stepCount(h.agent)).toBe(1)
    expect(h.execute).not.toHaveBeenCalled()
    const result = h.agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(JSON.stringify(result)).toContain('context-only load does not allow tool calls')
    expect(JSON.stringify(result)).not.toContain('UNKNOWN_TOOL')
    expect(h.ctx.codeRuntime.run).not.toHaveBeenCalled()
  })

  it('enforces the tool dispatch veto before model admission, including nested-dispatch-shaped calls', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const h = await harness([text()])
    h.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      entered.resolve()
      await release.promise
      return await next()
    })
    h.queue()
    await entered.promise
    const result = await h.ctx.tools.execute({
      callId: ToolCallId('nested-test'), rootCallId: ToolCallId('run-code-root'),
      name: 'bash', arguments: {}, agent: h.agent, signal: new AbortController().signal,
    })
    release.resolve()
    await h.agent.whenIdle()
    expect(result).toMatchObject({ isError: true })
    expect(JSON.stringify(result)).toContain('context-only load')
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('keeps another agent unrestricted while the briefing is in flight', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const h = await harness([async () => { entered.resolve(); await release.promise; return text() }, text('Other agent')])
    h.queue()
    await entered.promise
    const other = await h.ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'briefing-test', model: 'fake' })
    other.followup(human('Ordinary task'))
    await other.whenIdle()
    expect(h.adapter.requests[0]?.tools ?? []).toEqual([])
    expect(h.adapter.requests[1]?.tools?.map(tool => tool.name)).toContain('bash')
    release.resolve()
    await h.agent.whenIdle()
  })

  it('defers human steering received during streaming to a separate unrestricted turn', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const h = await harness([async () => { entered.resolve(); await release.promise; return text() }, text('Human task')])
    h.queue()
    await entered.promise
    const message = human('Do not make any decision; explain only.')
    h.agent.steer(message)
    expect(h.agent.inbox.nextStep).toHaveLength(0)
    expect(h.agent.inbox.nextTurn.map(item => item.id)).toContain(message.id)
    release.resolve()
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
    expect(requestText(h.adapter.requests[0]!)).not.toContain('Do not make any decision')
    expect(requestText(h.adapter.requests[1]!)).toContain('Do not make any decision')
    expect(stepCount(h.agent, 1)).toBe(1)
    expect(stepCount(h.agent, 2)).toBe(1)
    expect(h.adapter.requests[1]?.tools?.map(tool => tool.name)).toContain('bash')
    const admitted = h.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === message.id)
    expect(admitted).toHaveLength(1)
  })

  it('defers a human message introduced by another pre-step hook without losing its identity', async () => {
    const h = await harness([text(), text('Separate human reply')])
    const message = human('User input raced with pre-step admission')
    h.ctx.on('agent/pre-step', async ({ turn }, next) => {
      const decision = await next()
      return turn === 1 && decision.kind === 'enter' ? { ...decision, messages: [...decision.messages, message] } : decision
    })
    h.queue()
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
    expect(requestText(h.adapter.requests[0]!)).not.toContain('User input raced')
    expect(requestText(h.adapter.requests[1]!)).toContain('User input raced')
    expect(stepCount(h.agent, 1)).toBe(1)
  })

  it('durably parks plugin steering and followups without another model call, then delivers them to the next human turn', async () => {
    const h = await harness([text(), text('Normal response with background context')])
    const completedJob = notice('Job finished: measurements are ready', 'job-notification')
    const completedAgent = notice('Background agent found a limitation', 'agent-notification')
    h.ctx.on('agent/turn-stopping', ({ agent, turn }) => {
      if (turn !== 1) return
      agent.steer(completedJob)
      agent.followup(completedAgent)
    })
    h.queue()
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(1)
    expect(stepCount(h.agent)).toBe(1)
    expect(h.agent.inbox.nextTurn).toHaveLength(0)
    expect(h.agent.inbox.nextStep).toEqual(expect.arrayContaining([completedJob, completedAgent]))
    expect(h.agent.inbox.nextStep.some(message => message.source.kind === 'plugin'
      && message.source.plugin === 'dsh-profile-researcher:briefing-parked')).toBe(true)
    h.agent.followup(human('Explain the pending background results.'))
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
    expect(requestText(h.adapter.requests[1]!)).toContain('Job finished: measurements are ready')
    expect(requestText(h.adapter.requests[1]!)).toContain('Background agent found a limitation')
    expect(requestText(h.adapter.requests[1]!)).not.toContain('Background notifications were parked')
    expect(h.agent.inbox.nextTurn).toHaveLength(0)
  })

  it('preserves a notification arriving before briefing admission without including it in the brief', async () => {
    const h = await harness([text(), text('Later human reply')])
    h.queue()
    const notification = notice('Early background result', 'job-notification')
    h.agent.steer(notification)
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(1)
    expect(requestText(h.adapter.requests[0]!)).not.toContain('Early background result')
    expect(h.agent.inbox.nextStep).toContainEqual(notification)
    h.agent.followup(human('Now discuss the background result.'))
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
    expect(requestText(h.adapter.requests[1]!)).toContain('Early background result')
  })

  it('delivers parked notifications with human input that was already queued during streaming', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const h = await harness([async () => { entered.resolve(); await release.promise; return text() }, text('Human reply')])
    h.queue()
    await entered.promise
    h.agent.followup(human('Use the available background results.'))
    const notification = notice('Background result arrived after human input', 'agent-notification')
    h.agent.followup(notification)
    release.resolve()
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
    expect(requestText(h.adapter.requests[1]!)).toContain('Background result arrived after human input')
    expect(h.agent.inbox.nextStep).toHaveLength(0)
    expect(h.agent.inbox.nextTurn).toHaveLength(0)
  })

  it.each(['cancel', 'dispose'] as const)('preserves background notices across %s and producer reload', async ending => {
    const entered = Promise.withResolvers<void>()
    const h = await harness([request => { entered.resolve(); return aborting(request.signal) }, text('After reload')])
    h.queue()
    await entered.promise
    const notification = notice('Durable background notification', 'job-notification')
    h.agent.followup(notification)
    if (ending === 'cancel') {
      // Default cancel clears inbox: the guard must preserve unrelated facts anyway.
      h.agent.cancel({ kind: 'user' })
      await h.agent.whenIdle()
      await h.owner.dispose()
    } else await h.owner.dispose()
    expect(h.adapter.requests).toHaveLength(1)
    expect(h.agent.inbox.nextStep).toContainEqual(notification)
    await h.ctx.plugin({ name: 'briefing-after-cancel', inject: ['agents'], apply(ctx: Context) { new ResearchBriefings(ctx) } })
    h.ctx.emit('agent/session-start', { agent: h.agent, source: 'resume' })
    const later = notice('Second background notification', 'agent-notification')
    h.agent.followup(later)
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(1)
    expect(h.agent.inbox.nextStep).toEqual(expect.arrayContaining([notification, later]))
    h.agent.followup(human('Read the parked notifications.'))
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
    expect(requestText(h.adapter.requests[1]!)).toContain('Durable background notification')
    expect(requestText(h.adapter.requests[1]!)).toContain('Second background notification')
  })

  it.each(['reject', 'throw'] as const)('restores all unrelated claimed context when pre-step hooks %s', async kind => {
    const h = await harness([text('Human reply after rejected brief')])
    const fact = notice('Do not lose this claimed background fact')
    h.agent.inject(fact)
    h.ctx.on('agent/pre-step', async ({ turn }, next) => {
      if (turn !== 1) return await next()
      if (kind === 'throw') throw new Error('Downstream admission failed')
      return { kind: 'reject' }
    })
    h.queue()
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.agent.inbox.nextStep).toContainEqual(fact)
    h.agent.followup(human('Continue the discussion, not automatic research.'))
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(1)
    expect(requestText(h.adapter.requests[0]!)).toContain('Do not lose this claimed background fact')
  })

  it('explicit service.start lets a validated positive GoalDriver round consume parked notices', async () => {
    const enteredGoal = Promise.withResolvers<void>()
    const h = await harness([text(), () => { enteredGoal.resolve(); return text('Authorized goal work') }])
    const { service, target } = serviceFor(h)
    const notification = notice('Background facts for explicitly started work', 'job-notification')
    h.ctx.on('agent/turn-stopping', ({ turn }) => {
      if (turn === 1) h.agent.followup(notification)
      const goal = h.ctx.goals.get(h.agent)
      if (goal?.phase === 'active') h.ctx.goals.complete(h.agent, { id: goal.id, revision: goal.revision })
    })
    await service.load(h.agent, target.id)
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(1)
    expect(h.agent.inbox.nextStep).toContainEqual(notification)
    const started = await service.start(h.agent)
    expect(started.goalAction).toBe('created')
    await enteredGoal.promise
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
    expect(requestText(h.adapter.requests[1]!)).toContain('Background facts for explicitly started work')
    expect(requestText(h.adapter.requests[1]!)).not.toContain('Background notifications were parked')
    expect(h.adapter.requests[1]?.tools?.map(tool => tool.name)).toContain('bash')
    expect(h.ctx.goals.get(h.agent)).toMatchObject({ roundsStarted: 1, phase: 'complete' })
    expect(h.agent.inbox.nextStep).toHaveLength(0)
  })

  it.each(['no-service', 'wrong-id', 'stale-revision', 'stale-round', 'no-series', 'disarmed'] as const)(
    'does not unlock parked notices for forged Goal input: %s', async invalid => {
      const h = await harness([text()], false, 'native', invalid !== 'no-service')
      const notification = notice('Keep parked facts safe')
      h.ctx.on('agent/turn-stopping', ({ turn }) => { if (turn === 1) h.agent.followup(notification) })
      h.queue()
      await h.agent.whenIdle()
      // Isolate our validation from the real driver's independent provenance veto.
      await h.goalDriver?.dispose()
      const goal = invalid === 'no-service' ? undefined : h.ctx.goals.create(h.agent, { objective: 'A test Goal with no driver' })
      if (invalid === 'disarmed') h.ctx.goals.disarm(h.agent)
      h.ctx.on('agent/pre-step', async (_proposal, next) => {
        const decision = await next()
        return decision.kind === 'enter' && invalid !== 'no-series' ? { ...decision, startsRequestSeries: true } : decision
      })
      h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Forged Goal request' }], source: {
        kind: 'goal', goalId: invalid === 'wrong-id' || goal === undefined ? GoalId('wrong-goal') : goal.id,
        revision: invalid === 'stale-revision' ? 100 : goal?.revision ?? 1,
        round: invalid === 'stale-round' ? 0 : 1,
      } }))
      await h.agent.whenIdle()
      expect(h.adapter.requests).toHaveLength(1)
      expect(h.agent.inbox.nextStep).toContainEqual(notification)
      expect(h.agent.inbox.nextStep.some(message => message.source.kind === 'goal')).toBe(false)
    },
  )

  it('allows provider retry within the same admitted step without enabling tools', async () => {
    const failure: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', failure: { message: 'Transient test failure', code: 'TEST_RETRY' } } }]
    const h = await harness([failure, text()])
    h.ctx.on('agent/request-error', async () => ({ kind: 'retry' }))
    h.queue()
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
    expect(h.adapter.requests.every(request => (request.tools?.length ?? 0) === 0)).toBe(true)
    expect(stepCount(h.agent)).toBe(1)
    expect(h.briefings.busy(h.agent)).toBe(false)
  })

  it('cleans up terminal provider errors without automatically replaying the brief', async () => {
    const h = await harness([() => { throw new Error('Provider failed') }, text('Normal request after failure')])
    h.queue()
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(1)
    expect(h.briefings.busy(h.agent)).toBe(false)
    h.agent.followup(human('A new request'))
    await h.agent.whenIdle()
    expect(h.adapter.requests[1]?.tools?.map(tool => tool.name)).toContain('bash')
  })

  it('cleans up cancellation during streaming and retains subsequent human input', async () => {
    const entered = Promise.withResolvers<void>()
    const h = await harness([request => { entered.resolve(); return aborting(request.signal) }, text('After cancellation')])
    h.queue()
    await entered.promise
    h.agent.cancel({ kind: 'user' }, { keepInbox: true })
    const message = human('A new human request after cancellation')
    h.agent.followup(message)
    await h.agent.whenIdle()
    expect(h.briefings.busy(h.agent)).toBe(false)
    expect(h.adapter.requests).toHaveLength(2)
    expect(requestText(h.adapter.requests[1]!)).toContain('A new human request after cancellation')
    expect(h.adapter.requests[1]?.tools?.map(tool => tool.name)).toContain('bash')
  })

  it('rejects duplicate queue calls and cleans cancellation before admission', async () => {
    const h = await harness([])
    h.queue()
    expect(() => h.briefings.queue(h.agent)).toThrow(/idle live agent/)
    h.agent.cancel({ kind: 'user' })
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.briefings.busy(h.agent)).toBe(false)
  })

  it('rejects a same-source replacement token when a hook removes the exact reserved message id', async () => {
    const h = await harness([])
    h.ctx.on('agent/pre-step', async (_proposal, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return { ...decision, messages: [
        ...decision.messages.filter(message => !(message.source.kind === 'plugin' && message.source.plugin === SOURCE)),
        notice('Replacement with a different identity', SOURCE),
      ] }
    })
    h.queue()
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.briefings.busy(h.agent)).toBe(false)
    const ending = h.agent.session.snapshotEvents().find(event => event.type === 'turn/end')
    expect(JSON.stringify(ending)).toContain('reserved context-only message was removed')
  })

  it('removes stale persisted briefing tokens on session resume without consuming ordinary input', async () => {
    const h = await harness([text('Normal input after resume')])
    const stale = notice('Old briefing request', SOURCE)
    const message = human('Human input must survive resume')
    h.agent.inbox.append('next-turn', stale)
    h.agent.inbox.append('next-turn', message)
    h.ctx.emit('agent/session-start', { agent: h.agent, source: 'resume' })
    expect(h.agent.inbox.nextTurn.map(item => item.id)).toEqual([message.id])
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.briefings.busy(h.agent)).toBe(false)
  })

  it('sweeps stale tokens when installed over an already-live agent without waking it', async () => {
    const h = await harness([])
    await h.owner.dispose()
    const message = human('Preserve input across briefing plugin reload')
    h.agent.inbox.append('next-turn', notice('Expired briefing', SOURCE))
    h.agent.inbox.append('next-turn', message)
    await h.ctx.plugin({ name: 'briefing-reloaded', inject: ['agents'], apply(ctx: Context) { new ResearchBriefings(ctx) } })
    expect(h.agent.inbox.nextTurn.map(item => item.id)).toEqual([message.id])
    expect(h.adapter.requests).toHaveLength(0)
  })

  it('does not admit an unreserved token with matching plugin source or lose co-claimed human input', async () => {
    const h = await harness([])
    const message = human('Keep this input for a normal turn')
    h.agent.inject(message)
    h.agent.followup(notice('Stale or forged briefing', SOURCE))
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.agent.inbox.nextTurn.map(item => item.id)).toContain(message.id)
  })

  it('disposes the owner only after canceling its stream, preserving user input and removing restrictions', async () => {
    const entered = Promise.withResolvers<void>()
    const h = await harness([request => { entered.resolve(); return aborting(request.signal) }, text('After owner disposal')])
    h.queue()
    await entered.promise
    const message = human('Human input while briefing is active')
    h.agent.steer(message)
    await h.owner.dispose()
    expect(h.briefings.busy(h.agent)).toBe(false)
    expect(h.agent.inbox.nextTurn.map(item => item.id)).toContain(message.id)
    expect(() => h.briefings.queue(h.agent)).toThrow(/disposing/)
    expect(h.adapter.requests).toHaveLength(1)
    const assembly = await h.ctx.systemPrompt.assemble({ scope: h.agent, agent: h.agent })
    expect(assembly.tools.map(tool => tool.name)).toContain('bash')
  })
})
