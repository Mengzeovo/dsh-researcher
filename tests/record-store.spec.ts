import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecordStore, targetRoot, statePath, glossaryPath, runPath, sessionPath } from '../src/record-store.ts'
import { ResearchStore } from '../src/research-store.ts'
import { ResearchStore as CompatibilityResearchStore } from '../src/storage.ts'
import { appendStateText, renderOpenRun } from '../src/jsonl.ts'
import { RECORD_MAX_BYTES, parseResearchId, parseRunId, renderGoalMarkdown, researchRunDescriptionSchema, researchStateSchema } from '../src/schema.ts'
import { makeWorkspace, mockCheckpoints, removeWorkspace, testContext, testReproduction, testSession } from './helpers.ts'

const ID = parseResearchId('123e4567-e89b-42d3-a456-426614174001')
const RUN = parseRunId('123e4567-e89b-42d3-a456-426614174002')
const AT = '2025-01-01T00:00:00.000Z'
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await removeWorkspace(root)
})

async function fixture() {
  const root = await makeWorkspace('researcher-record-store'); roots.push(root)
  const ctx = testContext(root)
  const records = new RecordStore(ctx)
  const session = testSession(root)
  const directory = targetRoot(ID)
  const policy = await records.ensureDirectories(session, ['.research', '.research/goal', directory, `${directory}/runs`, `${directory}/session`])
  const state = researchStateSchema.parse({ version: 1, revision: 1, at: AT, sessionId: String(session.id), status: 'active', summary: 'Original state' })
  const goal = renderGoalMarkdown('Keep publication behavior unchanged.', ['exact records'], 'before the module split')
  await records.createText(session, `${directory}/goal.md`, goal, policy)
  await records.createText(session, statePath(ID), `${JSON.stringify(state)}\n`, policy)
  await records.createText(session, glossaryPath(ID), '{"version":1,"terms":{},"files":{}}\n', policy)
  return { root, ctx, records, session, state, goal, directory, policy }
}

describe('RecordStore persistence boundary', () => {
  it('keeps old and new ResearchStore import paths identical', () => {
    expect(CompatibilityResearchStore).toBe(ResearchStore)
  })

  it('returns parsed records together with their exact source and version observation', async () => {
    const f = await fixture()
    const goal = await f.records.readGoal(f.session, ID)
    expect(goal.text).toBe(f.goal)
    expect(goal.value.markdown).toBe(f.goal)
    expect(goal.relativePath).toBe(`${f.directory}/goal.md`)
    expect(goal.version).toBeDefined()
    expect(goal.target).toBeDefined()
    const state = await f.records.readStateLog(f.session, ID)
    expect(state.value.states).toEqual([f.state])
    expect(state.value.validText).toBe(state.text)
    expect((await f.records.readGlossary(f.session, ID)).value).toEqual({ version: 1, terms: {}, files: {} })
    expect(await f.records.readSessionIndex(f.session, ID)).toBeUndefined()
    expect((await f.records.listTargetEntries(f.session)).map(entry => entry.name)).toEqual([ID])
    expect(await f.records.listRunEntries(f.session, ID)).toEqual([])
  })

  it('preserves valid state bytes and trailing-fragment diagnostics for conditional publication', async () => {
    const f = await fixture()
    const prefix = JSON.stringify(f.state, null, 0).replace('{', '{ ') + '\n'
    const original = prefix + '{"version":1,"revision":'
    await writeFile(path.join(f.root, statePath(ID)), original)
    const observed = await f.records.readStateLog(f.session, ID)
    expect(observed.text).toBe(original)
    expect(observed.value.validText).toBe(prefix)
    expect(observed.value.warning).toContain('incomplete trailing JSON fragment')
    const next = { ...f.state, revision: 2, summary: 'Second state' }
    const published = appendStateText(observed.value, next)
    await f.records.replaceText(f.session, observed, statePath(ID), published)
    expect(await readFile(path.join(f.root, statePath(ID)), 'utf8')).toBe(prefix + JSON.stringify(next) + '\n')
  })

  it('rejects stale observations without rereading, retrying or overwriting newer bytes', async () => {
    const f = await fixture()
    const observed = await f.records.readStateLog(f.session, ID)
    const newer = JSON.stringify({ ...f.state, summary: 'Externally changed state with different byte length' }) + '\n'
    await writeFile(path.join(f.root, statePath(ID)), newer)
    const write = vi.spyOn(f.ctx.fs, 'writeText')
    const read = vi.spyOn(f.ctx.fs, 'readText')
    await expect(f.records.replaceText(f.session, observed, statePath(ID), observed.text)).rejects.toMatchObject({ code: 'RESEARCH_STALE_WRITE' })
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0]?.[2]).toEqual({ kind: 'replaceIfVersion', version: observed.version })
    expect(read).not.toHaveBeenCalled()
    expect(await readFile(path.join(f.root, statePath(ID)), 'utf8')).toBe(newer)
  })

  it('keeps create-if-absent conflict mapping and preserves existing bytes', async () => {
    const f = await fixture()
    await expect(f.records.createText(f.session, `${f.directory}/goal.md`, 'replacement', f.policy)).rejects.toMatchObject({ code: 'RESEARCH_STALE_WRITE' })
    expect(await readFile(path.join(f.root, f.directory, 'goal.md'), 'utf8')).toBe(f.goal)
  })

  it('refuses read-only writes and directory creation before touching files', async () => {
    const f = await fixture()
    const observed = await f.records.readStateLog(f.session, ID)
    const write = vi.spyOn(f.ctx.fs, 'writeText')
    vi.spyOn(f.ctx.sandboxPolicy, 'resolve').mockReturnValue({ mode: 'read-only', workspaceRoot: f.root })
    expect(() => f.records.writePolicy(f.session)).toThrow(/read-only/u)
    await expect(f.records.replaceText(f.session, observed, statePath(ID), 'changed')).rejects.toThrow(/read-only/u)
    await expect(f.records.ensureDirectories(f.session, ['new-directory'])).rejects.toThrow(/read-only/u)
    expect(write).not.toHaveBeenCalled()
    expect(await readFile(path.join(f.root, statePath(ID)), 'utf8')).toBe(observed.text)
    expect(await readdir(f.root)).not.toContain('new-directory')
  })

  it('rejects oversized authority records before loading their content and rejects invalid schemas', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, f.directory, 'goal.md'), 'x'.repeat(RECORD_MAX_BYTES + 1))
    const read = vi.spyOn(f.ctx.fs, 'readText')
    await expect(f.records.readGoal(f.session, ID)).rejects.toMatchObject({ code: 'RESEARCH_OVERSIZED' })
    expect(read).not.toHaveBeenCalled()
    await writeFile(path.join(f.root, glossaryPath(ID)), '{"version":99}')
    await expect(f.records.readGlossary(f.session, ID)).rejects.toMatchObject({ code: 'RESEARCH_INVALID_RECORD' })
  })

  it('rejects symlinks for authority records and real-directory checks', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'actual-goal.md'), f.goal)
    await rm(path.join(f.root, f.directory, 'goal.md'))
    await symlink(path.join(f.root, 'actual-goal.md'), path.join(f.root, f.directory, 'goal.md'))
    await expect(f.records.readGoal(f.session, ID)).rejects.toMatchObject({ code: 'RESEARCH_PATH_INVALID' })
    await rm(path.join(f.root, f.directory, 'runs'), { recursive: true })
    await mkdir(path.join(f.root, 'actual-runs'))
    await symlink(path.join(f.root, 'actual-runs'), path.join(f.root, f.directory, 'runs'))
    await expect(f.records.assertRealDirectory(f.session, `${f.directory}/runs`)).rejects.toMatchObject({ code: 'RESEARCH_PATH_INVALID' })
  })

  it('keeps project-reference compatibility distinct from authority files and avoids inspecting outside targets', async () => {
    const f = await fixture()
    const outside = await makeWorkspace('researcher-record-outside'); roots.push(outside)
    await writeFile(path.join(f.root, 'artifact.txt'), 'data')
    await writeFile(path.join(outside, 'external.txt'), 'external')
    await symlink(path.join(f.root, 'artifact.txt'), path.join(f.root, 'inside-link'))
    await symlink(outside, path.join(f.root, 'outside-link'))
    const inspect = await f.records.projectPathInspector(f.session)
    expect((await inspect('inside-link')).info?.type).toBe('file')
    expect((await inspect(f.directory)).info?.type).toBe('directory')
    expect(await inspect('missing.txt')).toEqual({ contained: true, info: undefined })
    const stat = vi.spyOn(f.ctx.fs, 'stat')
    expect(await inspect('outside-link/external.txt')).toEqual({ contained: false, info: undefined })
    expect(stat).not.toHaveBeenCalled()
    await expect(f.records.createText(f.session, '../escape.txt', 'unsafe', f.policy)).rejects.toMatchObject({ code: 'RESEARCH_PATH_INVALID' })
  })

  it('validates run ownership as well as its JSONL schema without inspecting Git', async () => {
    const f = await fixture()
    const other = parseResearchId('123e4567-e89b-42d3-a456-426614174003')
    const checkpoint = await mockCheckpoints().start(f.session, other, RUN, AT, testReproduction())
    const description = researchRunDescriptionSchema.parse({ version: 2, type: 'description', createdAt: AT, sessionId: String(f.session.id), purpose: 'record fixture', parameters: {}, baseStateRevision: 1, checkpoint })
    await f.records.createText(f.session, runPath(ID, RUN), renderOpenRun(description), f.policy)
    await expect(f.records.readRun(f.session, ID, RUN)).rejects.toMatchObject({ code: 'RESEARCH_INVALID_RECORD' })
    const legacy = researchRunDescriptionSchema.parse({ version: 1, type: 'description', createdAt: AT, sessionId: String(f.session.id), purpose: 'legacy fixture', parameters: {} })
    await writeFile(path.join(f.root, runPath(ID, RUN)), renderOpenRun(legacy))
    expect((await f.records.readRun(f.session, ID, RUN)).value).toEqual({ id: RUN, description: legacy })
  })

  it('validates session index filename identity while preserving the observed loadedAt', async () => {
    const f = await fixture()
    const relative = sessionPath(ID, String(f.session.id))
    const index = { version: 1, sessionId: String(f.session.id), loadedAt: AT, runIds: [RUN] }
    await f.records.createText(f.session, relative, JSON.stringify(index), f.policy)
    const observed = await f.records.readSessionIndex(f.session, ID)
    expect(observed?.relativePath).toBe(relative)
    expect(observed?.value).toEqual(index)
    await writeFile(path.join(f.root, relative), JSON.stringify({ ...index, sessionId: 'different-session' }))
    await expect(f.records.readSessionIndex(f.session, ID)).rejects.toMatchObject({ code: 'RESEARCH_INVALID_RECORD' })
  })

  it('allows sibling staging and preserves written bytes on directory publication', async () => {
    const f = await fixture()
    const id = parseResearchId('123e4567-e89b-42d3-a456-426614174004')
    const staging = `.research/goal/.creating-${id}`
    const policy = await f.records.ensureDirectories(f.session, [staging])
    await f.records.createText(f.session, `${staging}/goal.md`, f.goal, policy)
    expect((await f.records.listTargetEntries(f.session)).map(entry => entry.name)).toContain(`.creating-${id}`)
    await f.records.commitDirectory(f.session, staging, targetRoot(id))
    expect(await readFile(path.join(f.root, targetRoot(id), 'goal.md'), 'utf8')).toBe(f.goal)
    expect(await readdir(path.join(f.root, '.research/goal'))).not.toContain(`.creating-${id}`)
  })

  it('does not expose a partial research target when a staged write fails', async () => {
    const f = await fixture()
    const before = await readdir(path.join(f.root, '.research/goal'))
    const write = f.ctx.fs.writeText.bind(f.ctx.fs)
    vi.spyOn(f.ctx.fs, 'writeText').mockImplementation(async (...args) => {
      const name = (args[0] as unknown as { path: string }).path
      if (name.includes('.creating-') && name.endsWith('/state.jsonl')) throw new Error('staged write failed')
      return await write(...args)
    })
    const store = new ResearchStore(f.ctx, mockCheckpoints())
    await expect(store.createTarget(f.session, { goal: 'Should not become visible', metrics: ['all or nothing'], baseline: 'none' })).rejects.toThrow('staged write failed')
    expect(await readdir(path.join(f.root, '.research/goal'))).toEqual(before)
  })
})
