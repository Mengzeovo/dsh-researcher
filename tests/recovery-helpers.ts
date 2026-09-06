import type { Context } from '@deepseek-ai/cordis'
import { vi } from 'vitest'
import { applyResearcherBindingProjection, ResearcherService, type ResearcherBindingProjectionState } from '../src/index.ts'
import type { ResearchStore } from '../src/storage.ts'
import { testSession } from './helpers.ts'

export function recoveryHost(ctx: Context, store: ResearchStore, root: string, initialGoal?: Record<string, unknown>) {
  let projection: ResearcherBindingProjectionState = { bindings: {}, failure: null }
  let goal = initialGoal
  const session = Object.assign(testSession(root, 'fresh-session'), { events: [] as unknown[] })
  const agent = {
    id: session.id, session,
    inject: vi.fn((message) => {
      const event = { seq: session.events.length, type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, inserted: [message] } }
      session.events.push(event)
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
  }
  const service = Object.create(ResearcherService.prototype) as ResearcherService
  Object.defineProperties(service, {
    ctx: { value: { ...ctx, goals, sessionProjections: { stateOf: () => projection } } },
    store: { value: store }, activationGates: { value: new WeakMap() },
  })
  return { service, agent: agent as never, session, goals, injected: agent.inject }
}
