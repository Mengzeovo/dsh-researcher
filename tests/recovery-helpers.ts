import type { Context } from '@deepseek-ai/cordis'
import { vi } from 'vitest'
import { applyResearcherBindingProjection, ResearcherService, type ResearcherBindingProjectionState } from '../src/index.ts'
import type { ResearchStore } from '../src/storage.ts'
import { testSession } from './helpers.ts'

export type SessionApi = 'modern' | 'legacy'

/** The persisted log is independent of every snapshot returned to a caller. */
export function eventSession(root: string, id: string, api: SessionApi = 'modern') {
  const log: any[] = []
  const snapshotEvents = vi.fn(() => Object.freeze([...log]))
  const eventAt = vi.fn((seq: number) => log[seq])
  const session = testSession(root, id)
  if (api === 'modern') {
    Object.defineProperties(session, {
      seq: { configurable: true, get: () => log.length },
      snapshotEvents: { configurable: true, value: snapshotEvents },
      eventAt: { configurable: true, value: eventAt },
    })
  } else {
    Object.defineProperty(session, 'events', { configurable: true, get: () => Object.freeze([...log]) })
  }
  const appendEvent = (event: Record<string, unknown>) => {
    const appended = { ...event, seq: log.length, time: Date.now() }
    log.push(appended)
    return appended
  }
  return { session, log, snapshotEvents, eventAt, appendEvent }
}

export function recoveryHost(ctx: Context, store: ResearchStore, root: string, initialGoal?: Record<string, unknown>, api: SessionApi = 'modern', sessionId = 'fresh-session') {
  let projection: ResearcherBindingProjectionState = { sessionId, bindings: {}, failure: null }
  let goal = initialGoal
  const fixture = eventSession(root, sessionId, api)
  const { session, appendEvent } = fixture
  const agent = {
    id: session.id, session, status: 'idle', inbox: { nextStep: [], nextTurn: [] },
    inject: vi.fn((message) => {
      const event = appendEvent({ type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, inserted: [message] } })
      projection = applyResearcherBindingProjection(projection, event as never)
    }),
  }
  const goals = {
    get: () => goal,
    create: vi.fn((_agent, input: { objective: string }) => {
      goal = { id: 'goal-1', revision: 1, phase: 'active', activation: 'armed', roundsStarted: 0, maxGoalRounds: 24, ...input }
      return goal
    }),
    edit: vi.fn(), resume: vi.fn(), complete: vi.fn(),
    disarm: vi.fn(() => { if (goal !== undefined) goal = { ...goal, activation: 'disarmed' } }),
  }
  const service = Object.create(ResearcherService.prototype) as ResearcherService
  Object.defineProperties(service, {
    ctx: { value: { ...ctx, goals, sessionProjections: { stateOf: () => projection } } },
    store: { value: store }, activationGates: { value: new WeakMap() },
    loadingSessions: { value: new WeakSet() },
    briefings: { value: { busy: () => false, queue: vi.fn() } },
  })
  return { ...fixture, service, agent: agent as never, session, goals, injected: agent.inject }
}
