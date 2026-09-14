import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { sessionEventAt, sessionEvents, sessionNextSeq } from '../src/session-events.ts'
import { requireDirectHuman, researchToolExecution } from '../src/authority.ts'
import { apply } from '../src/tool.ts'

function fixture(session: unknown) {
  const agent = { id: 'isolated-research-regression', status: 'running', session }
  const ctx = {
    agents: { get: () => agent, currentInitiator: () => agent, roots: () => [agent] },
    sessionProjections: { stateOf: () => ({ openTurnStartSeq: 0 }) },
  }
  const registered = new Map<string, any>()
  const create = vi.fn(() => { throw new Error('storage must not be reached') })
  apply({ ...ctx, tools: { register: (tool: any) => registered.set(tool.name, tool) },
    researcher: { create } } as never)
  return { agent, ctx, create, createTool: registered.get('create_research') }
}

async function rejectsWithoutWrites(session: unknown) {
  const { agent, ctx, create, createTool } = fixture(session)
  const execution = researchToolExecution(ctx as never, { agent } as never)
  expect(() => requireDirectHuman(ctx as never, execution))
    .toThrow(expect.objectContaining({ code: 'RESEARCH_AUTHORITY_REQUIRED' }))
  expect(createTool).toBeDefined()
  await expect(createTool.execute({ goal: 'Isolated regression', metrics: ['Observable result'],
    baseline: 'No prior target' }, { agent }))
    .rejects.toMatchObject({ code: 'RESEARCH_AUTHORITY_REQUIRED' })
  expect(create).not.toHaveBeenCalled()
}

// These portable controls always run, regardless of host integration configuration.
describe.each(['legacy', 'modern'] as const)('%s Session entry regression', api => {
  const sessionFor = (events: unknown[]) => api === 'legacy' ? { events } : {
    snapshotEvents: () => events.slice(), seq: events.length,
    eventAt: (seq: number) => events[seq],
  }
  it('rejects an empty session by authority rather than TypeError, without writes', async () => {
    await rejectsWithoutWrites(sessionFor([]))
  })
  it('accepts current direct-human input', () => {
    const { agent, ctx } = fixture(sessionFor([
      { type: 'turn/start', data: {} },
      { type: 'user/message', data: { source: { kind: 'user' } } },
    ]))
    expect(() => requireDirectHuman(ctx as never,
      researchToolExecution(ctx as never, { agent } as never))).not.toThrow()
  })
})

const hostModule = process.env.DSH_RESEARCHER_SESSION_MODULE
it.skipIf(!hostModule)(
  'host Session entry regression (set DSH_RESEARCHER_SESSION_MODULE to enable; otherwise skipped)',
  async () => {
    // Accept a filesystem path, file URL, or package specifier, without a developer-specific path.
    const specifier = hostModule!.startsWith('.') || hostModule!.startsWith('/')
      ? pathToFileURL(resolve(hostModule!)).href : hostModule!
    const { Session } = await import(/* @vite-ignore */ specifier)
    const session = Session.create('isolated-research-regression')
    await rejectsWithoutWrites(session)

    // Both real generations accept typed append(type, data, surfaceIntent).
    // Construct valid identified messages rather than replacing the real event API.
    const turn = session.append('turn/start', { turn: 1 })
    const humanMessage = createUserMessage({
      content: [{ type: 'text', text: 'Create the isolated research target.' }],
      source: { kind: 'user' },
    })
    const humanEvent = session.append('user/message', humanMessage, { surfaceOp: 'append' })
    const { agent, ctx, create } = fixture(session)
    ctx.sessionProjections.stateOf = () => ({ openTurnStartSeq: turn.seq })
    const execution = researchToolExecution(ctx as never, { agent } as never)
    expect(() => requireDirectHuman(ctx as never, execution)).not.toThrow()
    expect(sessionEventAt(session, humanEvent.seq)).toBe(humanEvent)
    expect(create).not.toHaveBeenCalled()

    const before = sessionEvents(session)
    const injectionSeq = sessionNextSeq(session)
    expect(injectionSeq).toBe(before.length)
    expect(sessionEventAt(session, injectionSeq)).toBeUndefined()
    const injected = createUserMessage({
      content: [{ type: 'text', text: 'Isolated injected research context.' }],
      source: { kind: 'plugin', plugin: 'dsh-profile-researcher', form: 'snapshot',
        sections: [{ name: 'researcher:identity', text: 'isolated fixture' }] },
    })
    // This is the durable append made by inject(); no real agent/store is needed.
    const splice = session.append('agent/inbox/spliced', {
      target: 'next-step', start: 0, removedCount: 0, inserted: [injected],
    })
    expect(splice.seq).toBe(injectionSeq)
    expect(sessionEventAt(session, injectionSeq)).toBe(splice)
    expect(sessionEventAt(session, injectionSeq)).toMatchObject({
      type: 'agent/inbox/spliced', data: { target: 'next-step', inserted: [injected] },
    })
    expect(sessionNextSeq(session)).toBe(injectionSeq + 1)
    expect(before).toHaveLength(injectionSeq)
    expect(before[injectionSeq]).toBeUndefined()
    expect(execution.events).toEqual(before)
    expect(sessionEvents(session)).toEqual([...before, splice])
    expect(sessionEventAt(session, injectionSeq + 1)).toBeUndefined()

    // A new turn cannot borrow authority from that real historical human event.
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const nextTurn = session.append('turn/start', { turn: 2 })
    session.append('user/message', injected, { surfaceOp: 'append' })
    ctx.sessionProjections.stateOf = () => ({ openTurnStartSeq: nextTurn.seq })
    expect(() => requireDirectHuman(ctx as never,
      researchToolExecution(ctx as never, { agent } as never)))
      .toThrow(expect.objectContaining({ code: 'RESEARCH_AUTHORITY_REQUIRED' }))
  },
)
