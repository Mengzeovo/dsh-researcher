import type { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { researchBindingFromMessage, researchGoalObjective } from '../src/context.ts'
import { sessionPath } from '../src/record-store.ts'
import { parseResearchId } from '../src/schema.ts'
import { ResearchStore } from '../src/storage.ts'
import { apply as applyTools } from '../src/tool.ts'
import { makeWorkspace, removeWorkspace, testContext } from './helpers.ts'
import { recoveryHost, type SessionApi } from './recovery-helpers.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await removeWorkspace(root)
})

async function bench(api: SessionApi) {
  const root = await makeWorkspace('researcher-create-tool'); roots.push(root)
  const ctx = testContext(root)
  const store = new ResearchStore(ctx)
  const host = recoveryHost(ctx, store, root, undefined, api, 'creator-session')
  host.appendEvent({ type: 'turn/start' })
  host.appendEvent({ type: 'user/message', data: { source: { kind: 'user' } } })
  const agent = Object.assign(host.agent as object, { status: 'running' })
  const definitions = new Map<string, ToolDefinition>()
  applyTools({
    agents: { get: () => agent, currentInitiator: () => agent, roots: () => [agent] },
    sessionProjections: { stateOf: () => ({ openTurnStartSeq: 0 }) },
    goals: host.goals, researcher: host.service,
    tools: { register: (tool: ToolDefinition) => definitions.set(tool.name, tool) },
  } as unknown as Context)
  const tool = definitions.get('create_research')!
  const invoke = () => tool.execute({ goal: 'Create through the original human-authorized tool', metrics: ['durable project files'], baseline: 'no research exists', direction: 'test both Session APIs', next: 'load from a new session' }, { agent } as never)
  return { root, ctx, store, host, tool, invoke }
}

describe.each(['modern', 'legacy'] as const)('create_research end to end (%s Session API)', api => {
  it('creates real project files, binds, injects context, creates a matching Goal and loads in a new session', async () => {
    const b = await bench(api)
    if (api === 'modern') expect('events' in b.host.session).toBe(false)
    const snapshot = api === 'modern' ? b.host.session.snapshotEvents() : (b.host.session as unknown as { events: readonly unknown[] }).events
    const bind = vi.spyOn(b.store, 'bindSession')
    const value = await b.invoke()
    expect(validateJsonSchemaValue(b.tool.output.schema, value)).toEqual([])
    const result = value as { id: string; root: string; goal_action: string; recovery_command: string }
    const id = parseResearchId(result.id)
    expect(result).toMatchObject({ goal_action: 'created', recovery_command: `/research-load ${id}` })
    expect(bind).toHaveBeenCalledOnce()
    expect(b.host.injected).toHaveBeenCalledOnce()
    expect(bind.mock.invocationCallOrder[0]).toBeLessThan(b.host.injected.mock.invocationCallOrder[0]!)
    expect(b.host.injected.mock.invocationCallOrder[0]).toBeLessThan(b.host.goals.create.mock.invocationCallOrder[0]!)
    expect(b.host.service.binding(b.host.session)?.researchId).toBe(id)
    const message = b.host.injected.mock.calls[0]![0]
    expect(researchBindingFromMessage(message)).toMatchObject({ researchId: id, sessionId: 'creator-session' })
    expect(snapshot).toHaveLength(2)
    expect(b.host.log).toHaveLength(3)
    if (api === 'modern') expect(b.host.eventAt).toHaveBeenCalledWith(2)
    const target = await b.store.readTarget(b.host.session, id)
    expect(b.host.goals.create.mock.calls[0]![1].objective).toBe(researchGoalObjective(target))
    expect(JSON.stringify(message)).toContain(target.goal.goal)
    expect(await readdir(path.join(b.root, result.root))).toEqual(expect.arrayContaining(['goal.md', 'state.jsonl', 'glossary.json', 'session']))
    const goalBytes = await readFile(path.join(b.root, result.root, 'goal.md'), 'utf8')
    expect(goalBytes).toContain('Create through the original human-authorized tool')
    const stateBytes = await readFile(path.join(b.root, result.root, 'state.jsonl'), 'utf8')
    expect(JSON.parse(stateBytes.trim())).toMatchObject({ revision: 1, status: 'active', sessionId: 'creator-session' })
    expect(JSON.parse(await readFile(path.join(b.root, result.root, 'glossary.json'), 'utf8'))).toMatchObject({ version: 1, terms: {}, files: {} })
    expect(JSON.parse(await readFile(path.join(b.root, sessionPath(id, 'creator-session')), 'utf8'))).toMatchObject({ sessionId: 'creator-session', runIds: [] })

    const fresh = recoveryHost(b.ctx, new ResearchStore(b.ctx), b.root, undefined, api, 'reader-session')
    if (api === 'modern') expect('events' in fresh.session).toBe(false)
    const loaded = await fresh.service.load(fresh.agent, id)
    expect(loaded).toMatchObject({ researchId: id, eventSeq: 0, goalAction: 'unchanged', briefing: 'queued' })
    expect(fresh.service.binding(fresh.session)?.researchId).toBe(id)
    expect(loaded.context.text).toContain('Create through the original human-authorized tool')
    expect(fresh.goals.create).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(path.join(b.root, sessionPath(id, 'reader-session')), 'utf8'))).toMatchObject({ sessionId: 'reader-session', runIds: [] })
    expect(await readFile(path.join(b.root, result.root, 'goal.md'), 'utf8')).toBe(goalBytes)
    expect(await readFile(path.join(b.root, result.root, 'state.jsonl'), 'utf8')).toBe(stateBytes)
  })
})
