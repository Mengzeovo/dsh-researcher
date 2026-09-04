import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply as applyCommand } from '../src/command.ts'
import { buildResearchContext, createResearchContextMessage } from '../src/context.ts'
import { ResearcherError } from '../src/errors.ts'
import {
  applyResearcherBindingProjection,
  ResearcherService,
  researcherBindingProjectionDefinition,
  type ResearcherBindingProjectionState,
} from '../src/index.ts'
import { parseGoalMarkdown, parseResearchId, renderGoalMarkdown, stableJsonLine } from '../src/schema.ts'
import type { ResearchLoadResult, ResearchTargetSnapshot } from '../src/types.ts'

const ID = parseResearchId('123e4567-e89b-42d3-a456-426614174000')
const AT = '2026-03-01T00:00:00.000Z'

function bindingMessage(
  researchId = ID,
  sessionId = 'session-1',
  loadedAt = AT,
) {
  return createResearchContextMessage({
    text: stableJsonLine({ version: 1, researchId, sessionId, loadedAt }),
    sections: [{
      name: 'researcher:binding',
      text: stableJsonLine({ version: 1, researchId, sessionId, loadedAt }),
    }],
  })
}

function bindingEvent(seq: number, message = bindingMessage()) {
  return {
    seq,
    time: Date.parse(AT),
    type: 'agent/inbox/spliced',
    data: { target: 'next-step', start: 0, inserted: [message] },
  } as const
}

function target(status: 'active' | 'paused' | 'blocked' | 'complete' = 'active'): ResearchTargetSnapshot {
  const goal = parseGoalMarkdown(renderGoalMarkdown('Continue the bound research.', ['metric passes'], 'baseline'))
  return {
    id: ID,
    root: `.research/goal/${ID}`,
    goalPath: `.research/goal/${ID}/goal.md`,
    goal,
    state: {
      version: 1,
      revision: 1,
      at: AT,
      sessionId: 'session-1',
      status,
      summary: 'initial state',
    },
    glossary: { version: 1, terms: {}, files: {} },
    warnings: [],
  }
}

describe('researcher binding projection', () => {
  it('uses a core-known persisted event rather than a downstream event type', async () => {
    const catalogUrl = new URL('../node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js', import.meta.url)
    const catalog = await import(catalogUrl.href) as { KNOWN_SESSION_EVENT_TYPES: ReadonlySet<string> }
    expect(catalog.KNOWN_SESSION_EVENT_TYPES.has('agent/inbox/spliced')).toBe(true)
    expect(catalog.KNOWN_SESSION_EVENT_TYPES.has('researcher/load')).toBe(false)
  })

  it('folds known durable inbox loads and retains malformed/conflicting replay failures', () => {
    const initial = researcherBindingProjectionDefinition.init()
    const first = applyResearcherBindingProjection(initial, bindingEvent(1) as never)
    expect(first.bindings['session-1']?.researchId).toBe(ID)
    const repeated = applyResearcherBindingProjection(first, bindingEvent(
      2,
      bindingMessage(ID, 'session-1', '2026-03-02T00:00:00.000Z'),
    ) as never)
    expect(repeated.failure).toBeNull()

    const malformedMessage = createResearchContextMessage({
      text: '{}',
      sections: [{ name: 'researcher:binding', text: '{"version":2}' }],
    })
    const malformed = applyResearcherBindingProjection(repeated, bindingEvent(3, malformedMessage) as never)
    expect(malformed.failure).toMatch(/replay failed at event 3/u)
    expect(applyResearcherBindingProjection(malformed, bindingEvent(4) as never)).toBe(malformed)

    const other = parseResearchId('123e4567-e89b-42d3-b456-426614174001')
    const conflict = applyResearcherBindingProjection(first, bindingEvent(
      5,
      bindingMessage(other, 'session-1'),
    ) as never)
    expect(conflict.failure).toMatch(/conflicting ids/u)

    const forkBinding = applyResearcherBindingProjection(first, bindingEvent(
      6,
      bindingMessage(other, 'session-child'),
    ) as never)
    expect(forkBinding.failure).toBeNull()
    expect(forkBinding.bindings['session-child']?.researchId).toBe(other)
  })
})

describe('Host service activation', () => {
  function bench(initialTarget = target()) {
    let projection: ResearcherBindingProjectionState = { bindings: {}, failure: null }
    let goal: Record<string, unknown> | undefined
    const delivered: unknown[] = []
    const store = {
      readTarget: vi.fn(async () => initialTarget),
      resumeState: vi.fn(async () => target('active')),
      bindSession: vi.fn(async () => {}),
    }
    const session = {
      id: 'session-1',
      header: { cwd: '/tmp/researcher-host-test' },
      events: [] as unknown[],
    }
    const agent = {
      id: 'session-1',
      session,
      inject(message: unknown) {
        delivered.push(message)
        const event = bindingEvent(session.events.length, message as ReturnType<typeof bindingMessage>)
        session.events.push(event)
        projection = applyResearcherBindingProjection(projection, event as never)
      },
    }
    const goals = {
      get: () => goal,
      create: vi.fn((_agent, input: { objective: string }) => {
        goal = {
          id: 'goal-1',
          revision: 1,
          objective: input.objective,
          phase: 'active',
          activation: 'armed',
          roundsStarted: 0,
          maxGoalRounds: 24,
        }
        return goal
      }),
      edit: vi.fn((_agent, _ref, input: { objective: string }) => {
        goal = { ...goal, objective: input.objective, revision: Number(goal?.revision ?? 0) + 1 }
        return goal
      }),
      resume: vi.fn(() => {
        goal = { ...goal, phase: 'active', activation: 'armed', revision: Number(goal?.revision ?? 0) + 1 }
        return goal
      }),
      complete: vi.fn(() => {
        goal = { ...goal, phase: 'complete', activation: 'disarmed' }
        return goal
      }),
    }
    const ctx = {
      goals,
      sessionProjections: { stateOf: () => projection },
    }
    const service = Object.create(ResearcherService.prototype) as ResearcherService
    Object.defineProperty(service, 'ctx', { value: ctx })
    Object.defineProperty(service, 'store', { value: store })
    Object.defineProperty(service, 'activationGates', { value: new WeakMap() })
    return {
      service,
      agent: agent as never,
      session,
      store,
      goals,
      delivered,
      setGoal: (value: Record<string, unknown> | undefined) => { goal = value },
      projection: () => projection,
    }
  }

  it('revalidates, binds, injects context, and creates the matching Goal in order', async () => {
    const b = bench()
    const loaded = await b.service.load(b.agent, ID)
    expect(loaded.goalAction).toBe('created')
    expect(b.store.readTarget).toHaveBeenCalledOnce()
    expect(b.store.bindSession).toHaveBeenCalledOnce()
    expect(b.projection().bindings['session-1']?.researchId).toBe(ID)
    expect(b.delivered).toHaveLength(1)
    expect(b.goals.create).toHaveBeenCalledOnce()
    expect((b.goals.create.mock.calls[0]?.[1] as { objective: string }).objective).toMatch(new RegExp(`^\\[researcher:${ID}\\]`, 'u'))
  })

  it('resumes paused project state before injecting it', async () => {
    const b = bench(target('paused'))
    const loaded = await b.service.load(b.agent, ID)
    expect(b.store.resumeState).toHaveBeenCalledOnce()
    expect(loaded.target.state.status).toBe('active')
  })

  it('fails closed on a different unfinished Goal before binding or injection', async () => {
    const b = bench()
    b.setGoal({
      id: 'goal-other',
      revision: 1,
      objective: '[researcher:123e4567-e89b-42d3-b456-426614174001] other',
      phase: 'active',
      activation: 'armed',
      roundsStarted: 0,
    })
    await expect(b.service.load(b.agent, ID)).rejects.toMatchObject({ code: 'RESEARCH_GOAL_CONFLICT' })
    expect(b.store.bindSession).not.toHaveBeenCalled()
    expect(b.delivered).toEqual([])
    expect(b.projection().bindings['session-1']).toBeUndefined()
  })

  it('preflights exhausted Goal capacity before binding or injection', async () => {
    const b = bench()
    b.setGoal({
      id: 'goal-1',
      revision: 2,
      objective: `[researcher:${ID}] existing`,
      phase: 'paused',
      activation: 'disarmed',
      roundsStarted: 3,
      maxGoalRounds: 3,
    })
    await expect(b.service.load(b.agent, ID)).rejects.toMatchObject({ code: 'RESEARCH_GOAL_CONFLICT' })
    expect(b.store.bindSession).not.toHaveBeenCalled()
    expect(b.delivered).toEqual([])
  })

  it('serializes concurrent different-id loads without poisoning the binding projection', async () => {
    const b = bench()
    const other = parseResearchId('123e4567-e89b-42d3-b456-426614174001')
    b.store.readTarget.mockImplementation(async (_session: unknown, id: typeof ID) => ({
      ...target(),
      id,
      root: `.research/goal/${id}`,
      goalPath: `.research/goal/${id}/goal.md`,
    }))
    const settled = await Promise.allSettled([
      b.service.load(b.agent, ID),
      b.service.load(b.agent, other),
    ])
    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(b.projection().failure).toBeNull()
    expect(b.projection().bindings['session-1']?.researchId).toBe(ID)
  })

  it('loads completed targets view-only without manufacturing a new Goal', async () => {
    const b = bench(target('complete'))
    const loaded = await b.service.load(b.agent, ID)
    expect(loaded.goalAction).toBe('view-only')
    expect(b.goals.create).not.toHaveBeenCalled()
  })
})

describe('/research-load Host command', () => {
  function commandBench(loadImpl?: () => Promise<ResearchLoadResult>) {
    let descriptor: { handler(invocation: unknown): Promise<unknown> } | undefined
    const loadedTarget = target()
    const result: ResearchLoadResult = {
      researchId: ID,
      eventSeq: 42,
      target: loadedTarget,
      context: buildResearchContext(loadedTarget, {
        version: 1,
        researchId: ID,
        sessionId: 'session-1',
        loadedAt: AT,
      }),
      goalAction: 'created',
    }
    const load = vi.fn(loadImpl ?? (async () => result))
    const ctx = {
      commands: { register: (value: typeof descriptor) => { descriptor = value } },
      researcher: { load },
    }
    applyCommand(ctx as unknown as Context)
    const agent = { inject: vi.fn() }
    const invoke = async (rawInput: string, attachments: unknown[] = []) => {
      if (descriptor === undefined) throw new Error('command was not registered')
      return await descriptor.handler({ rawInput, attachments, agent, signal: undefined })
    }
    return { invoke, load, agent }
  }

  it('keeps the bare command headless-safe and rejects malformed arguments', async () => {
    const b = commandBench()
    await expect(b.invoke('')).resolves.toMatchObject({ kind: 'error' })
    await expect(b.invoke('a b')).resolves.toMatchObject({ kind: 'error', text: 'Usage: /research-load <research-id>' })
    await expect(b.invoke(String(ID), [{}])).resolves.toMatchObject({ kind: 'error' })
    expect(b.load).not.toHaveBeenCalled()
  })

  it('returns the authoritative binding event sequence on success', async () => {
    const b = commandBench()
    const reply = await b.invoke(String(ID))
    expect(reply).toMatchObject({ kind: 'success', sourceEventSeq: 42 })
    expect(b.load).toHaveBeenCalledOnce()
  })

  it('renders stable researcher errors instead of throwing through command dispatch', async () => {
    const b = commandBench(async () => {
      throw new ResearcherError('different Goal owns the session', 'RESEARCH_GOAL_CONFLICT')
    })
    await expect(b.invoke(String(ID))).resolves.toEqual({
      kind: 'error',
      text: 'RESEARCH_GOAL_CONFLICT: different Goal owns the session',
    })
  })
})
