import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
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

describe.each(['legacy', 'modern'] as const)('%s Session authority integration', (api) => {
  function fixture(sources: unknown[], openTurnStartSeq = 0) {
    const events = sources.map(source => source === null
      ? { type: 'turn/start', data: {} }
      : event(source)) as SessionEvent[]
    const session = api === 'legacy' ? { events } : {
      snapshotEvents: () => events.slice(),
      get seq() { return events.length },
      eventAt: (seq: number) => events[seq],
    }
    const agent = { id: 'root', status: 'running', session }
    const goal = { id: 'goal-1', revision: 3, roundsStarted: 2, objective: `[researcher:${ID}] continue` }
    const ctx = {
      agents: { get: () => agent, currentInitiator: () => agent, roots: () => [agent] },
      goals: { get: () => goal },
      sessionProjections: { stateOf: () => ({ openTurnStartSeq }) },
    }
    const run = () => researchToolExecution(ctx as unknown as Context, { agent } as never)
    return { agent, ctx, goal, run }
  }

  it('authorizes a current human through the live driver', () => {
    const { ctx, run } = fixture([null, { kind: 'user' }])
    expect(() => requireDirectHuman(ctx as unknown as Context, run())).not.toThrow()
    expect(() => requireResearchMutation(ctx as unknown as Context, run(), ID)).not.toThrow()
  })

  it.each([{ kind: 'plugin', plugin: 'other' }, { kind: 'agent', agentId: 'child' }])(
    'never borrows historical human authority for %j', source => {
      const { ctx, run } = fixture([null, { kind: 'user' }, null, source], 2)
      expect(() => requireDirectHuman(ctx as unknown as Context, run()))
        .toThrow(expect.objectContaining({ code: 'RESEARCH_AUTHORITY_REQUIRED' }))
      expect(() => requireResearchMutation(ctx as unknown as Context, run(), ID))
        .toThrow(expect.objectContaining({ code: 'RESEARCH_AUTHORITY_REQUIRED' }))
    },
  )

  it('does not treat a human event at the boundary as current input', () => {
    const { ctx, run } = fixture([null, { kind: 'user' }], 1)
    expect(() => requireDirectHuman(ctx as unknown as Context, run()))
      .toThrow(expect.objectContaining({ code: 'RESEARCH_AUTHORITY_REQUIRED' }))
  })

  it('does not grant subagents direct-human mutation authority', () => {
    const { ctx, run } = fixture([null, { kind: 'user' }])
    ctx.agents.roots = () => []
    expect(() => requireDirectHuman(ctx as unknown as Context, run()))
      .toThrow(expect.objectContaining({ code: 'RESEARCH_AUTHORITY_REQUIRED' }))
    expect(() => requireResearchMutation(ctx as unknown as Context, run(), ID))
      .toThrow(expect.objectContaining({ code: 'RESEARCH_AUTHORITY_REQUIRED' }))
  })

  it('matches every Goal field and the target in the current turn only', () => {
    const source = { kind: 'goal', goalId: 'goal-1', revision: 3, round: 2 }
    const { ctx, run } = fixture([null, source])
    expect(() => requireResearchMutation(ctx as unknown as Context, run(), ID)).not.toThrow()
    expect(() => requireDirectHuman(ctx as unknown as Context, run()))
      .toThrow(expect.objectContaining({ code: 'RESEARCH_AUTHORITY_REQUIRED' }))
    for (const invalid of [
      { ...source, goalId: 'other' }, { ...source, revision: 2 }, { ...source, round: 1 },
    ]) {
      const f = fixture([null, invalid])
      expect(() => requireResearchMutation(f.ctx as unknown as Context, f.run(), ID))
        .toThrow(expect.objectContaining({ code: 'RESEARCH_AUTHORITY_REQUIRED' }))
    }
    const historical = fixture([null, source, null, { kind: 'plugin' }], 2)
    expect(() => requireResearchMutation(historical.ctx as unknown as Context, historical.run(), ID))
      .toThrow(expect.objectContaining({ code: 'RESEARCH_AUTHORITY_REQUIRED' }))
    ctx.goals.get = () => ({ id: 'goal-1', revision: 3, roundsStarted: 2,
      objective: '[researcher:123e4567-e89b-42d3-b456-426614174001] other' })
    expect(() => requireResearchMutation(ctx as unknown as Context, run(), ID))
      .toThrow(expect.objectContaining({ code: 'RESEARCH_AUTHORITY_REQUIRED' }))
  })

  it('requires the exact registered agent and current initiator', () => {
    const { ctx, agent, run } = fixture([null, { kind: 'user' }])
    expect(() => researchToolExecution(ctx as unknown as Context, {} as never))
      .toThrow(expect.objectContaining({ code: 'RESEARCH_DRIVER_REQUIRED' }))
    ctx.agents.get = () => ({ ...agent })
    expect(run).toThrow(expect.objectContaining({ code: 'RESEARCH_DRIVER_REQUIRED' }))
    ctx.agents.get = () => agent
    ctx.agents.currentInitiator = () => ({ ...agent })
    expect(run).toThrow(expect.objectContaining({ code: 'RESEARCH_DRIVER_REQUIRED' }))
    ctx.agents.currentInitiator = () => agent
    agent.status = 'idle'
    expect(run).toThrow(expect.objectContaining({ code: 'RESEARCH_DRIVER_REQUIRED' }))
    agent.status = 'running'
    ctx.sessionProjections.stateOf = () => undefined as never
    expect(run).toThrow(expect.objectContaining({ code: 'RESEARCH_DRIVER_REQUIRED' }))
    ctx.sessionProjections.stateOf = () => ({ openTurnStartSeq: null as never })
    expect(run).toThrow(expect.objectContaining({ code: 'RESEARCH_DRIVER_REQUIRED' }))
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
