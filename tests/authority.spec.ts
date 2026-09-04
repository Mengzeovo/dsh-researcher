import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  requireDirectHuman,
  requireResearchMutation,
  researchToolExecution,
  type ResearchToolExecution,
} from '../src/authority.ts'
import { parseResearchId } from '../src/schema.ts'

const ID = parseResearchId('123e4567-e89b-42d3-a456-426614174000')

function event(source: unknown) {
  return { type: 'user/message', data: { source } }
}

function execution(agent: object, source: unknown): ResearchToolExecution {
  return {
    agent: agent as never,
    events: [
      { type: 'turn/start', data: {} } as never,
      event(source) as never,
    ],
    openTurnStartSeq: 0,
  }
}

describe('research mutation authority', () => {
  it('accepts direct human input only on the root agent', () => {
    const root = { id: 'root' }
    const child = { id: 'child' }
    const ctx = { agents: { roots: () => [root] }, goals: { get: () => undefined } } as unknown as Context
    expect(() => requireDirectHuman(ctx, execution(root, { kind: 'user' }))).not.toThrow()
    expect(() => requireDirectHuman(ctx, execution(child, { kind: 'user' })))
      .toThrow(expect.objectContaining({ code: 'RESEARCH_AUTHORITY_REQUIRED' }))
  })

  it('accepts only the exact current matching Goal Round for automatic mutations', () => {
    const agent = { id: 'root' }
    const goal = {
      id: 'goal-1',
      revision: 3,
      roundsStarted: 2,
      objective: `[researcher:${ID}] continue`,
    }
    const ctx = {
      agents: { roots: () => [agent] },
      goals: { get: () => goal },
    } as unknown as Context
    const valid = execution(agent, { kind: 'goal', goalId: 'goal-1', revision: 3, round: 2 })
    expect(() => requireResearchMutation(ctx, valid, ID)).not.toThrow()

    for (const source of [
      { kind: 'goal', goalId: 'goal-other', revision: 3, round: 2 },
      { kind: 'goal', goalId: 'goal-1', revision: 2, round: 2 },
      { kind: 'goal', goalId: 'goal-1', revision: 3, round: 1 },
      { kind: 'plugin', plugin: 'other' },
    ]) {
      expect(() => requireResearchMutation(ctx, execution(agent, source), ID))
        .toThrow(expect.objectContaining({ code: 'RESEARCH_AUTHORITY_REQUIRED' }))
    }
  })

  it('rejects a Goal Round whose marker names another research target', () => {
    const agent = { id: 'root' }
    const ctx = {
      agents: { roots: () => [agent] },
      goals: {
        get: () => ({
          id: 'goal-1',
          revision: 1,
          roundsStarted: 1,
          objective: '[researcher:123e4567-e89b-42d3-b456-426614174001] other',
        }),
      },
    } as unknown as Context
    expect(() => requireResearchMutation(
      ctx,
      execution(agent, { kind: 'goal', goalId: 'goal-1', revision: 1, round: 1 }),
      ID,
    )).toThrow(expect.objectContaining({ code: 'RESEARCH_AUTHORITY_REQUIRED' }))
  })
})

describe('tool execution driver gate', () => {
  it('requires the exact live running initiator and an open turn boundary', () => {
    const session = { events: [{ type: 'turn/start', data: {} }] }
    const agent = { id: 'session-1', session, status: 'running' }
    const boundary = { openTurnStartSeq: 0 }
    const ctx = {
      agents: {
        get: () => agent,
        currentInitiator: () => agent,
      },
      sessionProjections: { stateOf: () => boundary },
    } as unknown as Context
    expect(researchToolExecution(ctx, { agent } as never).agent).toBe(agent)

    agent.status = 'idle'
    expect(() => researchToolExecution(ctx, { agent } as never))
      .toThrow(expect.objectContaining({ code: 'RESEARCH_DRIVER_REQUIRED' }))
    agent.status = 'running'
    boundary.openTurnStartSeq = null as never
    expect(() => researchToolExecution(ctx, { agent } as never))
      .toThrow(expect.objectContaining({ code: 'RESEARCH_DRIVER_REQUIRED' }))
  })
})
