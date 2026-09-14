import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { planDirectory, planLedgerPath, planVersionPath } from '../src/plan-records.ts'
import { runPath, statePath, targetRoot } from '../src/record-store.ts'
import { RECORD_MAX_BYTES } from '../src/schema.ts'
import { projectResearchView } from '../src/view-projection.ts'
import { planContent, viewConfig, viewFixture, viewRequest, viewToken } from './view-test-helpers.ts'

afterEach(() => vi.restoreAllMocks())
async function treeBytes(root: string, relative = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name)
    if (entry.isDirectory()) Object.assign(result, await treeBytes(root, file))
    else result[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')
  }
  return result
}
describe('read-only research view data', () => {
  it('reads actual plan partitions and committed runs without Agent or authority writes', async () => {
    const f = await viewFixture()
    const run = await f.addRun()
    await f.addVersion(1, 1, [{ runId: run.runId, reason: '误差支持修订' }])
    await f.store.createPlan(f.session, f.target.id, { ...planContent, title: 'Independent plan' })
    const before = await treeBytes(path.join(f.root, '.research'))
    const write = vi.spyOn(f.ctx.fs, 'writeText')
    const data = await f.read()
    expect(Object.hasOwn(f.ctx, 'agent')).toBe(false)
    expect(data.plans.map(record => [record.document.metadata.plan_id, record.document.metadata.revision])).toEqual([[1, 1], [1, 2], [2, 1]])
    expect(data.runs).toHaveLength(1)
    expect(data.runs[0]).toMatchObject({ committed: true, run: { description: { planRef: { planId: 1, revision: 1, sha256: f.initial.plan.sha256 } } } })
    expect(write).not.toHaveBeenCalled()
    expect(await treeBytes(path.join(f.root, '.research'))).toEqual(before)
  })

  it('rejects a symlinked runs directory even when its referent is inside the same target', async () => {
    const f = await viewFixture()
    await f.addRun()
    const runs = path.join(f.root, targetRoot(f.target.id), 'runs')
    const referent = path.join(f.root, targetRoot(f.target.id), 'stored-runs')
    await rename(runs, referent)
    // Windows directory junctions exercise lstat without requiring symlink privileges.
    await symlink(referent, runs, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await realpath(runs)).toBe(await realpath(referent))
    const listRuns = vi.spyOn(f.records, 'listRunEntries')
    const readRun = vi.spyOn(f.records, 'readRun')
    await expect(f.read()).rejects.toMatchObject({ code: 'RESEARCH_PATH_INVALID' })
    expect(listRuns).not.toHaveBeenCalled()
    expect(readRun).not.toHaveBeenCalled()
  })

  it('rejects a target directory alias before reading goal, state or any authority bytes', async () => {
    const f = await viewFixture()
    const directory = path.join(f.root, targetRoot(f.target.id))
    const referent = directory + '-stored'
    await rename(directory, referent)
    await symlink(referent, directory, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await realpath(directory)).toBe(await realpath(referent))
    const readGoal = vi.spyOn(f.records, 'readGoal')
    const readState = vi.spyOn(f.records, 'readStateLog')
    const readText = vi.spyOn(f.ctx.fs, 'readText')
    const readBytes = vi.spyOn(f.ctx.fs, 'readBytes')
    await expect(f.read()).rejects.toMatchObject({ code: 'RESEARCH_PATH_INVALID' })
    expect(readGoal).not.toHaveBeenCalled()
    expect(readState).not.toHaveBeenCalled()
    expect(readText).not.toHaveBeenCalled()
    expect(readBytes).not.toHaveBeenCalled()
  })

  it('reports bad ledgers, non-directories, missing and altered versions without hiding a healthy partition', async () => {
    const f = await viewFixture()
    await f.addVersion(1, 1)
    await f.store.createPlan(f.session, f.target.id, { ...planContent, title: 'Bad ledger plan' })
    await f.store.createPlan(f.session, f.target.id, { ...planContent, title: 'Healthy partition' })
    await rm(path.join(f.root, planVersionPath(f.target.id, 1, 2)))
    const first = path.join(f.root, planVersionPath(f.target.id, 1, 1))
    await writeFile(first, (await readFile(first, 'utf8')).replace('Measure estimator', 'Measure modified'))
    await writeFile(path.join(f.root, planLedgerPath(f.target.id, 2)), '{not json}\n')
    await writeFile(path.join(f.root, planDirectory(f.target.id, 9)), 'not a directory')
    await mkdir(path.join(f.root, path.dirname(planDirectory(f.target.id, 1)), 'not-a-plan'))
    const data = await f.read()
    expect(data.planDirectories).toEqual([1, 2, 3])
    expect(data.diagnostics).toContainEqual(expect.objectContaining({ code: 'PLAN_UNREGISTERED_ENTRY' }))
    expect(data.plans.map(record => record.document.metadata.plan_id)).toEqual([3])
    expect(new Set(data.diagnostics.map(item => item.planId).filter(id => id !== undefined))).toEqual(new Set([1, 2, 9]))
    expect(data.diagnostics.some(item => item.path === planVersionPath(f.target.id, 1, 2))).toBe(true)
    expect(data.diagnostics.some(item => item.path === planVersionPath(f.target.id, 1, 1))).toBe(true)
    const { snapshot } = projectResearchView(data, viewToken, viewRequest({ planId: 3 }), viewConfig)
    expect(snapshot.groups.map(group => group.planId)).toEqual([1, 2, 3])
    expect(snapshot.groups.find(group => group.planId === 3)?.title).toBe('Healthy partition')
    expect(snapshot.nodes).toHaveLength(1)
  })

  it('retains oversized single-record diagnostics and unregistered versions', async () => {
    const f = await viewFixture()
    await f.store.createPlan(f.session, f.target.id, { ...planContent, title: 'Healthy' })
    await writeFile(path.join(f.root, planVersionPath(f.target.id, 1, 1)), 'x'.repeat(RECORD_MAX_BYTES + 1))
    await writeFile(path.join(f.root, planVersionPath(f.target.id, 1, 2)), 'unpublished version')
    const data = await f.read()
    expect(data.plans.map(record => record.document.metadata.plan_id)).toEqual([2])
    expect(data.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'RESEARCH_OVERSIZED', path: planVersionPath(f.target.id, 1, 1) }),
      expect.objectContaining({ code: 'PLAN_UNPUBLISHED_VERSION', path: planVersionPath(f.target.id, 1, 2) }),
    ]))
  })

  it('changes record identity for publication and run bytes without relying on state revision', async () => {
    const f = await viewFixture()
    const before = await f.read()
    await f.addVersion(1, 1)
    const published = await f.read()
    expect(published.state.revision).toBe(before.state.revision)
    expect(published.recordVersion).not.toBe(before.recordVersion)
    const started = await f.addRun(1, 1)
    const runBefore = await f.read()
    const file = path.join(f.root, runPath(f.target.id, started.runId))
    const original = await readFile(file, 'utf8')
    await writeFile(file, original.replace('测量误差', '测量不同误差'))
    const runAfter = await f.read()
    expect(runAfter.state.revision).toBe(runBefore.state.revision)
    expect(runAfter.recordVersion).not.toBe(runBefore.recordVersion)
    expect(runAfter.runs[0]!.sha256).not.toBe(runBefore.runs[0]!.sha256)
  })

  it('bounds records and full UTF-8 inputs, permits exact budget, and honors cancellation', async () => {
    const f = await viewFixture()
    const goal = await f.records.readGoal({ workspaceRoot: f.root }, f.target.id)
    const state = await f.records.readStateLog({ workspaceRoot: f.root }, f.target.id)
    const ledger = await f.records.readPlanLedger({ workspaceRoot: f.root }, f.target.id, 1)
    const version = await f.records.readPlanDocument({ workspaceRoot: f.root }, f.target.id, 1, 1)
    const bytes = [goal.text, state.text, ledger.text, version.text].reduce((sum, text) => sum + Buffer.byteLength(text), 0)
    expect(bytes).toBeGreaterThan([goal.text, state.text, ledger.text, version.text].join('').length)
    expect((await f.read({ ...viewConfig, maxDataBytes: bytes, maxRecords: 4 })).plans).toHaveLength(1)
    await expect(f.read({ ...viewConfig, maxDataBytes: bytes - 1 })).rejects.toMatchObject({ code: 'RESEARCH_OVERSIZED' })
    await expect(f.read({ ...viewConfig, maxDataBytes: 1 })).rejects.toMatchObject({ code: 'RESEARCH_OVERSIZED' })
    await expect(f.read({ ...viewConfig, maxRecords: 3 })).rejects.toMatchObject({ code: 'RESEARCH_OVERSIZED' })
    const controller = new AbortController(); controller.abort()
    await expect(f.read(viewConfig, controller.signal)).rejects.toBeDefined()
  })

  it('reads a legacy checkpoint Run with no plan reference without inventing a partition', async () => {
    const f = await viewFixture()
    const started = await f.addRun(1, 1, 'open')
    const file = path.join(f.root, runPath(f.target.id, started.runId))
    const description = JSON.parse((await readFile(file, 'utf8')).trim()) as Record<string, unknown>
    delete description.planRef; description.version = 2
    await writeFile(file, JSON.stringify(description) + '\n')
    const data = await f.read()
    expect(data.runs[0]?.run.description.version).toBe(2)
    const snapshot = projectResearchView(data, viewToken, viewRequest(), viewConfig).snapshot
    expect(snapshot.groups.map(group => group.planId)).toEqual([1])
    expect(snapshot.nodes.map(node => node.kind)).toEqual(['plan'])
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: 'RUN_WITHOUT_PLAN' }))
  })

  it('distinguishes missing state publication from completed committed state', async () => {
    const f = await viewFixture()
    const started = await f.addRun()
    const committed = await f.read()
    expect(committed.runs[0]?.committed).toBe(true)
    const stateFile = path.join(f.root, statePath(f.target.id))
    const rows = (await readFile(stateFile, 'utf8')).trim().split('\n')
    await writeFile(stateFile, rows.slice(0, -1).join('\n') + '\n')
    const pending = await f.read()
    expect(pending.runs.find(record => record.run.id === started.runId)?.committed).toBe(false)
  })
})
