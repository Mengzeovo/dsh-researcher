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
import { eventSession } from './recovery-helpers.ts'
import { testSession } from './helpers.ts'

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
    const initial = researcherBindingProjectionDefinition.init(testSession('/workspace', 'session-1').header)
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

describe.each(['modern', 'legacy'] as const)('Host service activation (%s Session API)', api => {
  function bench(initialTarget = target()) {
    let projection: ResearcherBindingProjectionState = { sessionId: 'session-1', bindings: {}, failure: null }
    let goal: Record<string, unknown> | undefined
    const delivered: unknown[] = []
    const store = {
      canonicalWorkspace: vi.fn(async () => '/tmp/researcher-host-test'),
      readTarget: vi.fn(async () => initialTarget),
      resumeState: vi.fn(async () => target('active')),
      bindSession: vi.fn(async () => {}),
    }
    const fixture = eventSession('/tmp/researcher-host-test', 'session-1', api)
    const { session, appendEvent } = fixture
    const agent = {
      id: 'session-1',
      session, status: 'idle', inbox: { nextStep: [], nextTurn: [] },
      inject: vi.fn((message: unknown) => {
        delivered.push(message)
        const event = appendEvent(bindingEvent(0, message as ReturnType<typeof bindingMessage>))
        projection = applyResearcherBindingProjection(projection, event as never)
      }),
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
      disarm: vi.fn(() => { if (goal !== undefined) goal = { ...goal, activation: 'disarmed' } }),
      complete: vi.fn(() => {
        goal = { ...goal, phase: 'complete', activation: 'disarmed' }
        return goal
      }),
    }
    const ctx = {
      emit: vi.fn(),
      goals,
      sessionProjections: { stateOf: () => projection },
    }
    const service = Object.create(ResearcherService.prototype) as ResearcherService
    Object.defineProperty(service, 'ctx', { value: ctx })
    Object.defineProperty(service, 'store', { value: store })
    Object.defineProperty(service, 'activationGates', { value: new WeakMap() })
    Object.defineProperty(service, 'loadingSessions', { value: new WeakSet() })
    const briefings = { busy: vi.fn(() => false), queue: vi.fn() }
    Object.defineProperty(service, 'briefings', { value: briefings })
    return {
      ...fixture,
      inject: agent.inject,
      service,
      agent: agent as never,
      session,
      store,
      goals,
      delivered, briefings,
      setGoal: (value: Record<string, unknown> | undefined) => { goal = value },
      projection: () => projection,
    }
  }

  it('revalidates, binds and queues a briefing without creating a Goal', async () => {
    const b = bench()
    const loaded = await b.service.load(b.agent, ID)
    expect(loaded).toMatchObject({ goalAction: 'unchanged', mode: 'context-only', briefing: 'queued' })
    expect(b.store.readTarget).toHaveBeenCalledOnce()
    expect(b.store.bindSession).toHaveBeenCalledOnce()
    expect(b.projection().bindings['session-1']?.researchId).toBe(ID)
    expect(b.delivered).toHaveLength(1)
    expect(b.goals.create).not.toHaveBeenCalled()
    expect(b.briefings.queue).toHaveBeenCalledWith(b.agent)
    expect(b.inject.mock.invocationCallOrder[0]).toBeLessThan(b.briefings.queue.mock.invocationCallOrder[0]!)
  })

  it('reads the exact appended sequence without treating an old snapshot as live', async () => {
    const b = bench()
    b.appendEvent({ type: 'turn/start' })
    b.appendEvent({ type: 'user/message', data: { source: { kind: 'user' } } })
    const oldSnapshot = api === 'modern' ? b.session.snapshotEvents() : (b.session as unknown as { events: readonly unknown[] }).events
    if (api === 'modern') expect('events' in b.session).toBe(false)
    const loaded = await b.service.load(b.agent, ID)
    expect(loaded.eventSeq).toBe(2)
    expect(oldSnapshot).toHaveLength(2)
    expect(b.log).toHaveLength(3)
    expect(b.log[2]).toMatchObject({ seq: 2, type: 'agent/inbox/spliced' })
    if (api === 'modern') expect(b.eventAt).toHaveBeenCalledWith(2)
  })

  it('rejects injection that does not persist an event before activating a Goal', async () => {
    const b = bench()
    b.inject.mockImplementation(() => {})
    await expect(b.service.load(b.agent, ID)).rejects.toMatchObject({ code: 'RESEARCH_INVALID_RECORD' })
    expect(b.store.bindSession).toHaveBeenCalledOnce()
    expect(b.goals.create).not.toHaveBeenCalled()
  })

  it('rejects an appended event carrying the wrong research binding', async () => {
    const b = bench()
    const other = parseResearchId('123e4567-e89b-42d3-b456-426614174001')
    b.inject.mockImplementation(() => { b.appendEvent(bindingEvent(0, bindingMessage(other))) })
    await expect(b.service.load(b.agent, ID)).rejects.toMatchObject({ code: 'RESEARCH_INVALID_RECORD' })
    expect(b.goals.create).not.toHaveBeenCalled()
  })

  it('does not search past the exact expected sequence for a matching binding', async () => {
    const b = bench()
    b.inject.mockImplementation(message => {
      b.appendEvent({ type: 'turn/start' })
      b.appendEvent(bindingEvent(0, message as ReturnType<typeof bindingMessage>))
    })
    await expect(b.service.load(b.agent, ID)).rejects.toMatchObject({ code: 'RESEARCH_INVALID_RECORD' })
    expect(b.goals.create).not.toHaveBeenCalled()
  })

  it('rejects unsupported Session APIs before binding or injection', async () => {
    const b = bench(target('paused'))
    for (const key of ['events', 'snapshotEvents', 'seq', 'eventAt']) Reflect.deleteProperty(b.session, key)
    await expect(b.service.load(b.agent, ID)).rejects.toMatchObject({ code: 'RESEARCH_SESSION_API_UNSUPPORTED' })
    expect(b.store.bindSession).not.toHaveBeenCalled()
    expect(b.store.resumeState).not.toHaveBeenCalled()
    expect(b.inject).not.toHaveBeenCalled()
    expect(b.goals.create).not.toHaveBeenCalled()
  })

  if (api === 'modern') {
    it('prefers modern accessors even when a legacy events getter is present', async () => {
      const b = bench()
      const legacyRead = vi.fn(() => { throw new Error('legacy events must not be read') })
      Object.defineProperty(b.session, 'events', { get: legacyRead })
      await expect(b.service.load(b.agent, ID)).resolves.toMatchObject({ eventSeq: 0, goalAction: 'unchanged' })
      expect(legacyRead).not.toHaveBeenCalled()
      expect(b.snapshotEvents).toHaveBeenCalled()
      expect(b.eventAt).toHaveBeenCalledWith(0)
    })

    it.each(['snapshotEvents', 'seq', 'eventAt'])('rejects incomplete modern API missing %s before binding', async key => {
      const b = bench()
      Reflect.deleteProperty(b.session, key)
      await expect(b.service.load(b.agent, ID)).rejects.toMatchObject({ code: 'RESEARCH_SESSION_API_UNSUPPORTED' })
      expect(b.store.bindSession).not.toHaveBeenCalled()
      expect(b.inject).not.toHaveBeenCalled()
      expect(b.goals.create).not.toHaveBeenCalled()
    })
  }

  it.each(['active', 'paused', 'blocked', 'complete'] as const)('loads %s without changing project state', async status => {
    const b = bench(target(status))
    const loaded = await b.service.load(b.agent, ID)
    expect(b.store.resumeState).not.toHaveBeenCalled()
    expect(loaded.target.state).toEqual(target(status).state)
    expect(b.goals.create).not.toHaveBeenCalled()
    expect(b.goals.resume).not.toHaveBeenCalled()
    expect(b.goals.complete).not.toHaveBeenCalled()
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

  it('allows an exhausted Goal to load but rejects explicit start', async () => {
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
    await expect(b.service.load(b.agent, ID)).resolves.toMatchObject({ goalAction: 'unchanged' })
    expect(b.store.bindSession).toHaveBeenCalledOnce()
    await expect(b.service.start(b.agent)).rejects.toMatchObject({ code: 'RESEARCH_GOAL_CONFLICT' })
    expect(b.goals.resume).not.toHaveBeenCalled()
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

  it('disarms a matching Goal without editing its durable fields', async () => {
    const b = bench()
    const original = { id: 'goal-1', revision: 7, objective: '[researcher:' + ID + '] original', phase: 'active', activation: 'armed', roundsStarted: 2, maxGoalRounds: 9 }
    b.setGoal(original)
    await expect(b.service.load(b.agent, ID)).resolves.toMatchObject({ goalAction: 'disarmed' })
    expect(b.goals.get()).toEqual({ ...original, activation: 'disarmed' })
    expect(b.goals.disarm).toHaveBeenCalledOnce()
    for (const action of [b.goals.edit, b.goals.resume, b.goals.complete]) expect(action).not.toHaveBeenCalled()
  })

  it('rejects busy sessions and concurrent duplicate loads without queueing a second briefing', async () => {
    const b = bench()
    Object.assign(b.agent, { status: 'running' })
    await expect(b.service.load(b.agent, ID)).rejects.toMatchObject({ code: 'RESEARCH_SESSION_BUSY' })
    expect(b.store.readTarget).not.toHaveBeenCalled()
    Object.assign(b.agent, { status: 'idle' })
    const pending = b.service.load(b.agent, ID)
    await expect(b.service.load(b.agent, ID)).rejects.toMatchObject({ code: 'RESEARCH_SESSION_BUSY' })
    await pending
    expect(b.briefings.queue).toHaveBeenCalledOnce()
  })

  it('rechecks input and Goal conflicts after asynchronous reads', async () => {
    const b = bench()
    b.store.bindSession.mockImplementation(async () => { Object.assign(b.agent, { inbox: { nextStep: [], nextTurn: [{}] } }) })
    await expect(b.service.load(b.agent, ID)).rejects.toMatchObject({ code: 'RESEARCH_SESSION_BUSY' })
    expect(b.inject).not.toHaveBeenCalled()
    expect(b.briefings.queue).not.toHaveBeenCalled()
  })

  it('starts only a loaded target, resuming project state and creating its Goal once', async () => {
    const b = bench(target('paused'))
    await expect(b.service.start(b.agent)).rejects.toMatchObject({ code: 'RESEARCH_NOT_FOUND' })
    await b.service.load(b.agent, ID)
    expect(b.goals.create).not.toHaveBeenCalled()
    const started = await b.service.start(b.agent)
    expect(started).toMatchObject({ goalAction: 'created', target: { state: { status: 'active' } } })
    expect(b.store.resumeState).toHaveBeenCalledOnce()
    expect(b.goals.create).toHaveBeenCalledOnce()
    // The real store persists the resumed snapshot; subsequent reads must observe it.
    b.store.readTarget.mockResolvedValue(started.target)
    const injections = b.inject.mock.calls.length
    await expect(b.service.start(b.agent)).resolves.toMatchObject({ goalAction: 'unchanged' })
    expect(b.inject).toHaveBeenCalledTimes(injections)
    expect(b.goals.create).toHaveBeenCalledOnce()
  })

  it('resumes paused project state even if its matching Goal was separately rearmed', async () => {
    const b = bench(target('paused'))
    await b.service.load(b.agent, ID)
    b.setGoal({ id: 'goal-1', revision: 1, objective: '[researcher:' + ID + '] old', phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 4 })
    const started = await b.service.start(b.agent)
    expect(started.target.state.status).toBe('active')
    expect(b.store.resumeState).toHaveBeenCalledOnce()
  })

  it('preflights exhausted armed Goals before resuming paused project state', async () => {
    const b = bench(target('paused'))
    await b.service.load(b.agent, ID)
    b.setGoal({ id: 'goal-1', revision: 1, objective: '[researcher:' + ID + '] old', phase: 'active', activation: 'armed', roundsStarted: 4, maxGoalRounds: 4 })
    await expect(b.service.start(b.agent)).rejects.toMatchObject({ code: 'RESEARCH_GOAL_CONFLICT' })
    expect(b.store.resumeState).not.toHaveBeenCalled()
  })

  it('reports partial briefing failure without rolling back binding or starting work', async () => {
    const b = bench()
    b.briefings.queue.mockImplementation(() => { throw new Error('brief unavailable') })
    await expect(b.service.load(b.agent, ID)).rejects.toMatchObject({ code: 'RESEARCH_BRIEFING_FAILED' })
    expect(b.service.binding(b.session)?.researchId).toBe(ID)
    expect(b.goals.create).not.toHaveBeenCalled()
    expect(b.store.resumeState).not.toHaveBeenCalled()
  })

  it('never starts completed targets or while a briefing is in progress', async () => {
    const b = bench(target('complete'))
    await b.service.load(b.agent, ID)
    await expect(b.service.start(b.agent)).rejects.toMatchObject({ code: 'RESEARCH_TARGET_COMPLETE' })
    b.briefings.busy.mockReturnValue(true)
    await expect(b.service.start(b.agent)).rejects.toMatchObject({ code: 'RESEARCH_SESSION_BUSY' })
    expect(b.goals.create).not.toHaveBeenCalled()
  })

  it('loads completed targets view-only without manufacturing a new Goal', async () => {
    const b = bench(target('complete'))
    const loaded = await b.service.load(b.agent, ID)
    expect(loaded.goalAction).toBe('unchanged')
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
      goalAction: 'unchanged', mode: 'context-only', briefing: 'queued',
    }
    const load = vi.fn(loadImpl ?? (async () => result))
    const ctx = {
      commands: { register: (value: typeof descriptor & { name: string }) => { if (value?.name === 'research-load') descriptor = value } },
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
