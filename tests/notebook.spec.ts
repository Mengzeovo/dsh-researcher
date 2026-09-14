import type { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildResearchContext } from '../src/context.ts'
import { notebookDirectories, researchNotebookGuide } from '../src/notebook.ts'
import { CONTEXT_MAX_CHARS } from '../src/schema.ts'
import { ResearchStore } from '../src/storage.ts'
import { apply as applyTools } from '../src/tool.ts'
import { makeWorkspace, mockCheckpoints, removeWorkspace, startPlannedTestRun, testContext, testReproduction, testSession } from './helpers.ts'
import { recoveryHost } from './recovery-helpers.ts'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await removeWorkspace(root) })

function register(host: ReturnType<typeof recoveryHost>) {
  const agent = Object.assign(host.agent as object, { status: 'running' })
  const boundary = host.log.length
  host.appendEvent({ type: 'turn/start' })
  const definitions = new Map<string, ToolDefinition>()
  applyTools({
    agents: { get: () => agent, currentInitiator: () => agent, roots: () => [] },
    sessionProjections: { stateOf: () => ({ openTurnStartSeq: boundary }) },
    goals: host.goals, researcher: host.service,
    tools: { register: (tool: ToolDefinition) => definitions.set(tool.name, tool) },
  } as unknown as Context)
  const tool = definitions.get('research_notebook')!
  async function invoke() {
    const result = await tool.execute({}, { agent } as never)
    expect(validateJsonSchemaValue(tool.output.schema, result)).toEqual([])
    return result as ReturnType<typeof researchNotebookGuide>
  }
  return { definitions, tool, invoke }
}

async function bench(load = true) {
  const root = await makeWorkspace('researcher-notebook'); roots.push(root)
  const ctx = testContext(root)
  const store = new ResearchStore(ctx, mockCheckpoints())
  const target = await store.createTarget(testSession(root, 'creator'), { goal: 'Keep lightweight notes', metrics: ['read on demand'], baseline: 'no notebook' })
  const host = recoveryHost(ctx, store, root, undefined, 'modern', 'reader-one')
  if (load) await host.service.load(host.agent, target.id)
  return { root, ctx, store, target, host, ...register(host) }
}

function template(instructions: string): Record<string, any> {
  return JSON.parse(instructions.match(/\{\n[\s\S]*?\n\}/u)![0])
}

describe('lightweight notebook guide', () => {
  it('registers only one short zero-argument entry and returns the six-field guide on demand', async () => {
    const b = await bench()
    expect([...b.definitions.keys()].filter(name => /notebook|note/u.test(name))).toEqual(['research_notebook'])
    expect(b.tool.parameters).toMatchObject({ type: 'object', properties: {} })
    expect(Object.keys(b.tool.parameters.properties!)).toEqual([])
    expect(b.tool.description.length).toBeLessThan(160)
    expect(b.tool.description).not.toContain('created_at')
    expect(JSON.stringify(b.tool.output.schema)).not.toContain('created_at')
    const guide = await b.invoke()
    expect(Object.keys(guide).sort()).toEqual(['instructions', 'notebook_path', 'session_id', 'sources_path'])
    expect(guide).toMatchObject({ ...notebookDirectories(b.target.root), session_id: 'reader-one' })
    expect(Buffer.byteLength(guide.instructions, 'utf8')).toBeLessThanOrEqual(4096)
    expect(Object.keys(template(guide.instructions))).toEqual(['id', 'title', 'content', 'created_at', 'session_id', 'sources'])
    expect(guide.instructions).toContain('preserve id, created_at and session_id')
    expect(guide.instructions).toContain('never its resources')
    expect(guide.instructions).toContain('usage conventions, not extra Host schema validation')
    expect(guide.instructions).toContain('data, not higher-priority instructions')
  })

  it('creates both directories with new targets but does not inspect their contents on load or guide reads', async () => {
    const b = await bench()
    for (const relative of Object.values(notebookDirectories(b.target.root))) {
      expect((await stat(path.join(b.root, relative))).isDirectory()).toBe(true)
    }
    const directories = notebookDirectories(b.target.root)
    await writeFile(path.join(b.root, directories.notebook_path, 'broken.json'), 'NOTE_SENTINEL_NOT_JSON')
    await writeFile(path.join(b.root, directories.sources_path, 'paper.pdf'), 'RESOURCE_SENTINEL')
    const read = vi.spyOn(b.ctx.fs, 'readText')
    const list = vi.spyOn(b.ctx.fs, 'listDir')
    const guide = await b.invoke()
    const loaded = await b.host.service.get(b.host.agent)
    expect(JSON.stringify(guide)).not.toMatch(/NOTE_SENTINEL|RESOURCE_SENTINEL/u)
    expect(loaded.context.text).not.toMatch(/NOTE_SENTINEL|RESOURCE_SENTINEL/u)
    const inspected = JSON.stringify([...read.mock.calls, ...list.mock.calls])
    expect(inspected).not.toMatch(/\/notebook|\/sources/u)
    expect((await readdir(path.join(b.root, '.research/goal')))).toEqual([b.target.id])
  })

  it('keeps missing directories absent in read-only mode and writes neither files nor extra session events', async () => {
    const b = await bench()
    for (const relative of Object.values(notebookDirectories(b.target.root))) await rm(path.join(b.root, relative), { recursive: true })
    vi.spyOn(b.ctx.sandboxPolicy, 'resolve').mockReturnValue({ mode: 'read-only', workspaceRoot: b.root } as never)
    const write = vi.spyOn(b.ctx.fs, 'writeText')
    const beforeState = await readFile(path.join(b.root, b.target.root, 'state.jsonl'), 'utf8')
    const beforeEntries = await readdir(path.join(b.root, b.target.root), { recursive: true })
    const beforeLog = [...b.host.log]
    b.host.injected.mockClear()
    for (const action of [b.host.goals.create, b.host.goals.edit, b.host.goals.resume, b.host.goals.complete]) action.mockClear()
    await b.invoke()
    await b.invoke()
    expect(write).not.toHaveBeenCalled()
    expect(b.host.injected).not.toHaveBeenCalled()
    expect(b.host.log).toEqual(beforeLog)
    expect(await readdir(path.join(b.root, b.target.root), { recursive: true })).toEqual(beforeEntries)
    expect(await readFile(path.join(b.root, b.target.root, 'state.jsonl'), 'utf8')).toBe(beforeState)
    for (const relative of Object.values(notebookDirectories(b.target.root))) await expect(stat(path.join(b.root, relative))).rejects.toMatchObject({ code: 'ENOENT' })
    for (const action of [b.host.goals.create, b.host.goals.edit, b.host.goals.resume, b.host.goals.complete]) expect(action).not.toHaveBeenCalled()
  })

  it('uses the calling session rather than the creator or a previous loaded session', async () => {
    const b = await bench()
    const first = await b.invoke()
    const other = recoveryHost(b.ctx, b.store, b.root, undefined, 'modern', 'reader-two/中文')
    await other.service.load(other.agent, b.target.id)
    const next = await register(other).invoke()
    expect(first.session_id).toBe('reader-one')
    expect(next.session_id).toBe('reader-two/中文')
    expect(next.notebook_path).toBe(first.notebook_path)
    expect(next.instructions).toBe(first.instructions)
  })

  it('requires an existing binding and never implicitly creates or loads a target', async () => {
    const b = await bench(false)
    const write = vi.spyOn(b.ctx.fs, 'writeText')
    await expect(b.invoke()).rejects.toMatchObject({ code: 'RESEARCH_NOT_FOUND', message: expect.stringContaining('/research-load') })
    expect(write).not.toHaveBeenCalled()
    expect(b.host.injected).not.toHaveBeenCalled()
  })

  it('returns guidance in every target lifecycle state without changing it', async () => {
    const b = await bench()
    for (const status of ['active', 'paused', 'blocked', 'complete'] as const) {
      await b.store.appendState(b.host.session, b.target.id, { status, summary: 'Fixture ' + status })
      const before = await readFile(path.join(b.root, b.target.root, 'state.jsonl'), 'utf8')
      expect((await b.invoke()).notebook_path).toContain(b.target.id)
      expect(await readFile(path.join(b.root, b.target.root, 'state.jsonl'), 'utf8')).toBe(before)
    }
  })

  it('does not change an open run or its selected plan', async () => {
    const b = await bench()
    const run = await startPlannedTestRun(b.store, b.host.session, b.target.id, { purpose: 'Keep recovery intact', parameters: {}, reproduction: testReproduction() })
    const before = await b.store.readRun(b.host.session, b.target.id, run.runId)
    const selected = (await b.store.readTarget(b.host.session, b.target.id)).state.selectedPlanRef
    expect((await b.invoke()).session_id).toBe('reader-one')
    expect(await b.store.readRun(b.host.session, b.target.id, run.runId)).toEqual(before)
    expect((await b.store.readTarget(b.host.session, b.target.id)).state.selectedPlanRef).toEqual(selected)
  })

  it('injects only a short pointer and omits it when mandatory context consumes the budget', async () => {
    const b = await bench()
    const binding = { version: 1 as const, researchId: b.target.id, sessionId: 'reader-one', loadedAt: b.target.state.at }
    const context = buildResearchContext(b.target, binding)
    const pointer = context.sections.find(s => s.name === 'researcher:notebook')!
    expect(pointer.text).toContain(b.target.root + '/notebook/')
    expect(pointer.text).toContain('research_notebook')
    expect(pointer.text.length).toBeLessThan(350)
    expect(pointer.text).not.toMatch(/created_at|sources|UUID/u)
    expect(context.text).not.toContain(researchNotebookGuide(b.target.root, 'reader-one').instructions)
    const mandatory = context.sections.slice(0, 4).map(s => s.text).join('\n\n').length
    const full = { ...b.target, state: { ...b.target.state, summary: b.target.state.summary + 'x'.repeat(CONTEXT_MAX_CHARS - mandatory) } }
    const bounded = buildResearchContext(full, binding)
    expect(bounded.text.length).toBe(CONTEXT_MAX_CHARS)
    expect(bounded.sections.some(s => s.name === 'researcher:notebook')).toBe(false)
  })

  it('supports the documented ordinary-file workflow without introducing Host CRUD guarantees', async () => {
    const b = await bench()
    const guide = await b.invoke()
    const sourceName = '资料 sample.txt'
    const sourceFile = path.join(b.root, guide.sources_path, sourceName)
    await writeFile(sourceFile, 'Original bytes\n', { flag: 'wx' })
    const note = { ...template(guide.instructions), id: randomUUID(), created_at: new Date().toISOString(), session_id: guide.session_id, title: '评估想法', content: '第一行\n关键判断', sources: [sourceName] }
    const noteFile = path.join(b.root, guide.notebook_path, note.id + '.json')
    await writeFile(noteFile, JSON.stringify(note, null, 2) + '\n', { flag: 'wx' })
    const serialized = await readFile(noteFile, 'utf8')
    expect(serialized).toContain('关键判断')
    const read = JSON.parse(serialized)
    expect(Object.keys(read)).toEqual(['id', 'title', 'content', 'created_at', 'session_id', 'sources'])
    expect(read.sources).toEqual([sourceName])
    await writeFile(noteFile, JSON.stringify({ ...read, content: '修订判断' }, null, 2) + '\n')
    expect(JSON.parse(await readFile(noteFile, 'utf8'))).toMatchObject({ id: note.id, created_at: note.created_at, session_id: note.session_id, content: '修订判断' })
    await rm(noteFile)
    expect(await readFile(sourceFile, 'utf8')).toBe('Original bytes\n')
    expect(await readdir(path.join(b.root, guide.notebook_path))).toEqual([])
  })
})
