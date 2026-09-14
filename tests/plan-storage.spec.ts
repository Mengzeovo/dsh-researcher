import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchStore } from '../src/research-store.ts'
import { planDirectory, planLedgerPath, planRoot, planVersionPath, parsePlanDocument, parsePlanLedger, renderPlanDocument } from '../src/plan-records.ts'
import { renderOpenRun } from '../src/jsonl.ts'
import { runPath, statePath } from '../src/record-store.ts'
import { parseRunId, researchRunDescriptionSchema } from '../src/schema.ts'
import type { PlanContentInput } from '../src/plan-schema.ts'
import type { FinishResearchRunRequest, RunId, StartResearchRunRequest } from '../src/types.ts'
import { failNextWrite, makeWorkspace, mockCheckpoints, removeWorkspace, testContext, testReproduction, testSession } from './helpers.ts'

const INPUT: PlanContentInput = { title: 'Compare errors', body: 'Run the candidate and baseline with the same seed; compare error and cost.', delta: ['Initial complete proposal'] }
const UPDATED: PlanContentInput = { title: 'Compare errors and robustness', body: 'Run both candidates at seeds 7 and 11; compare errors, cost, and failure cases.', delta: ['Add a second seed and robustness checks'] }
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await removeWorkspace(root)
})

async function fixture() {
  const root = await makeWorkspace('researcher-plan-storage'); roots.push(root)
  const ctx = testContext(root)
  const checkpoints = mockCheckpoints()
  const store = new ResearchStore(ctx, checkpoints)
  const session = testSession(root)
  const target = await store.createTarget(session, { goal: 'Validate plan publication and frozen run provenance.', metrics: ['exact snapshots and safe recovery'], baseline: 'no plans', direction: 'compare candidates', next: 'save a complete proposal' })
  return { root, ctx, checkpoints, store, session, target }
}

async function selectedFixture() {
  const f = await fixture()
  const created = await f.store.createPlan(f.session, f.target.id, INPUT)
  const selected = await f.store.selectPlan(f.session, f.target.id, { planId: 1, revision: 1, expectedStateRevision: f.target.state.revision })
  return { ...f, created, selected }
}

function startRequest(plan = { planId: 1, revision: 1 }): StartResearchRunRequest {
  return { purpose: 'Compare the selected route', parameters: { seed: 7 }, reproduction: testReproduction(), plan }
}

function finishRequest(runId: RunId, artifacts: readonly string[] = []): FinishResearchRunRequest {
  return { runId, status: 'completed', result: 'The candidate did not outperform the baseline.', metrics: { error: 0.3 }, decision: 'retain baseline', artifacts, researchStatus: 'active', summary: 'Baseline retained after controlled comparison.', next: 'review robustness' }
}

async function stateBytes(f: Awaited<ReturnType<typeof fixture>>) {
  return await readFile(path.join(f.root, statePath(f.target.id)), 'utf8')
}

describe('ResearchStore plan publication and recovery', () => {
  it('keeps old targets readable, publishes a staged initial pair, and never auto-selects or deduplicates creates', async () => {
    const f = await fixture()
    const before = await stateBytes(f)
    expect((await f.store.listPlans(f.session, f.target.id)).plans).toEqual([])
    expect((await f.store.readTarget(f.session, f.target.id)).state.selectedPlanRef).toBeUndefined()
    const created = await f.store.createPlan(f.session, f.target.id, INPUT)
    expect(created.plan.metadata).toMatchObject({ schema_version: 2, plan_id: 1, revision: 1, title: INPUT.title, delta: INPUT.delta, based_on_runs: [] })
    expect(created.path).toBe(planVersionPath(f.target.id, 1, 1))
    expect(created.latestRevision).toBe(1)
    expect(created.warnings).toEqual([])
    expect(await readdir(path.join(f.root, planRoot(f.target.id)))).toEqual(['0001'])
    expect((await readdir(path.join(f.root, planDirectory(f.target.id, 1)))).sort()).toEqual(['v0001.md', 'versions.jsonl'])
    const ledger = parsePlanLedger(1, await readFile(path.join(f.root, planLedgerPath(f.target.id, 1)), 'utf8'))
    expect(ledger.entries[0]).toMatchObject({ plan_id: 1, revision: 1, file: 'v0001.md', sha256: created.plan.sha256 })
    expect(await stateBytes(f)).toBe(before)
    const distinct = await f.store.createPlan(f.session, f.target.id, INPUT)
    expect(distinct.plan.metadata.plan_id).toBe(2)
    expect(await stateBytes(f)).toBe(before)
    expect(f.checkpoints.start).not.toHaveBeenCalled()
  })

  it('cleans failed initial staging without exposing a partial final plan', async () => {
    const f = await fixture()
    const before = await stateBytes(f)
    const original = f.ctx.fs.writeText.bind(f.ctx.fs)
    vi.spyOn(f.ctx.fs, 'writeText').mockImplementation(async (...args) => {
      const file = (args[0] as unknown as { path: string }).path
      if (file.includes('/plan/.creating-') && file.endsWith('/versions.jsonl')) throw new Error('staged ledger failure')
      return await original(...args)
    })
    await expect(f.store.createPlan(f.session, f.target.id, INPUT)).rejects.toThrow(/plan 1 creation failed.*staged ledger failure/u)
    expect(await readdir(path.join(f.root, planRoot(f.target.id)))).toEqual([])
    expect((await f.store.listPlans(f.session, f.target.id)).plans).toEqual([])
    expect(await stateBytes(f)).toBe(before)
  })

  it('reports uncertain post-commit failure with its assigned ID and leaves list/get recovery available', async () => {
    const f = await fixture()
    const read = vi.spyOn(f.ctx.fs, 'readBytes').mockRejectedValueOnce(new Error('readback failed after commit'))
    await expect(f.store.createPlan(f.session, f.target.id, INPUT)).rejects.toThrow(/plan 1 was published; inspect .*0001/u)
    read.mockRestore()
    const listed = await f.store.listPlans(f.session, f.target.id)
    expect(listed.plans.map(plan => plan.planId)).toEqual([1])
    expect((await f.store.getPlan(f.session, f.target.id, { planId: 1 })).plan.metadata.title).toBe(INPUT.title)
    expect(await readdir(path.join(f.root, planRoot(f.target.id)))).toEqual(['0001'])
  })

  it('allocates above all canonical final directories, ignores staging, and paginates invalid rows numerically', async () => {
    const f = await fixture()
    await f.store.createPlan(f.session, f.target.id, INPUT)
    await mkdir(path.join(f.root, planDirectory(f.target.id, 9)))
    await mkdir(path.join(f.root, planRoot(f.target.id), '.creating-9999-abandoned'))
    const created = await f.store.createPlan(f.session, f.target.id, UPDATED)
    expect(created.plan.metadata.plan_id).toBe(10)
    const first = await f.store.listPlans(f.session, f.target.id, { limit: 1 })
    expect(first.plans.map(plan => plan.planId)).toEqual([1])
    expect(first.nextAfterId).toBe(1)
    const invalid = await f.store.listPlans(f.session, f.target.id, { afterId: 1, limit: 1 })
    expect(invalid.plans).toEqual([])
    expect(invalid.invalid).toMatchObject([{ planId: 9 }])
    expect(invalid.nextAfterId).toBe(9)
    const last = await f.store.listPlans(f.session, f.target.id, { afterId: 9, limit: 1 })
    expect(last.plans.map(plan => plan.planId)).toEqual([10])
    expect(last.nextAfterId).toBeUndefined()
  })

  it('allows 9999 to 10000, rejects numeric non-directory collisions, and refuses safe-integer overflow', async () => {
    const f = await fixture()
    await f.store.createPlan(f.session, f.target.id, INPUT)
    await mkdir(path.join(f.root, planDirectory(f.target.id, 9999)))
    expect((await f.store.createPlan(f.session, f.target.id, UPDATED)).plan.metadata.plan_id).toBe(10000)
    await writeFile(path.join(f.root, planDirectory(f.target.id, 2)), 'not a directory')
    await expect(f.store.createPlan(f.session, f.target.id, INPUT)).rejects.toMatchObject({ code: 'RESEARCH_PATH_INVALID' })
    await rm(path.join(f.root, planDirectory(f.target.id, 2)))
    await mkdir(path.join(f.root, planDirectory(f.target.id, Number.MAX_SAFE_INTEGER)))
    const before = await readdir(path.join(f.root, planRoot(f.target.id)))
    await expect(f.store.createPlan(f.session, f.target.id, INPUT)).rejects.toThrow(/positive safe integers/u)
    expect(await readdir(path.join(f.root, planRoot(f.target.id)))).toEqual(before)
  })

  it('recovers only an exact next-orphan replay across sessions and keeps the original host timestamp and bytes', async () => {
    const f = await fixture()
    await f.store.createPlan(f.session, f.target.id, INPUT)
    const beforeState = await stateBytes(f)
    const ledgerPath = planLedgerPath(f.target.id, 1)
    const beforeLedger = await readFile(path.join(f.root, ledgerPath), 'utf8')
    const request = { planId: 1, expectedRevision: 1, ...UPDATED }
    await failNextWrite(f.ctx, ledgerPath, 'registration interrupted', 'replaceIfVersion')
    await expect(f.store.updatePlan(f.session, f.target.id, request)).rejects.toThrow('registration interrupted')
    const orphanPath = planVersionPath(f.target.id, 1, 2)
    const orphanText = await readFile(path.join(f.root, orphanPath), 'utf8')
    const original = parsePlanDocument(orphanText)
    const read = await f.store.getPlan(f.session, f.target.id, { planId: 1 })
    expect(read.latestRevision).toBe(1)
    expect(read.warnings.join('\n')).toContain(orphanPath)
    await expect(f.store.getPlan(f.session, f.target.id, { planId: 1, revision: 2 })).rejects.toMatchObject({ code: 'RESEARCH_NOT_FOUND' })
    await expect(f.store.updatePlan(f.session, f.target.id, { ...request, title: 'Changed retry' })).rejects.toMatchObject({ code: 'RESEARCH_PLAN_CONFLICT' })
    expect(await readFile(path.join(f.root, ledgerPath), 'utf8')).toBe(beforeLedger)
    const freshCtx = testContext(f.root)
    const fresh = new ResearchStore(freshCtx, f.checkpoints)
    const recovered = await fresh.updatePlan(testSession(f.root, 'fresh/retry'), f.target.id, request)
    expect(recovered.plan).toEqual(original)
    expect(recovered.latestRevision).toBe(2)
    expect(recovered.warnings).toEqual([])
    expect(await readFile(path.join(f.root, orphanPath), 'utf8')).toBe(orphanText)
    expect(await stateBytes(f)).toBe(beforeState)
    const write = vi.spyOn(freshCtx.fs, 'writeText')
    expect((await fresh.updatePlan(testSession(f.root, 'fresh/retry'), f.target.id, request)).plan).toEqual(original)
    expect(write).not.toHaveBeenCalled()
    await fresh.updatePlan(f.session, f.target.id, { ...request, expectedRevision: 2, delta: ['Third revision'] })
    await expect(fresh.updatePlan(f.session, f.target.id, request)).rejects.toMatchObject({ code: 'RESEARCH_STALE_WRITE' })
    expect((await fresh.getPlan(f.session, f.target.id, { planId: 1 })).latestRevision).toBe(3)
  })

  it('rejects malformed, divergent, and multiple future orphans without overwriting or skipping revisions', async () => {
    const f = await fixture()
    await f.store.createPlan(f.session, f.target.id, INPUT)
    const request = { planId: 1, expectedRevision: 1, ...UPDATED }
    const relative = planVersionPath(f.target.id, 1, 2)
    const ledgerBefore = await readFile(path.join(f.root, planLedgerPath(f.target.id, 1)), 'utf8')
    await writeFile(path.join(f.root, relative), 'not a plan')
    await expect(f.store.updatePlan(f.session, f.target.id, request)).rejects.toMatchObject({ code: 'RESEARCH_INVALID_RECORD' })
    expect(await readFile(path.join(f.root, relative), 'utf8')).toBe('not a plan')
    const valid = renderPlanDocument(1, 2, UPDATED, '2025-01-01T00:00:00.000Z')
    await writeFile(path.join(f.root, relative), valid.markdown)
    const futurePath = planVersionPath(f.target.id, 1, 3)
    await writeFile(path.join(f.root, futurePath), renderPlanDocument(1, 3, UPDATED, '2025-01-01T00:00:00.000Z').markdown)
    await expect(f.store.updatePlan(f.session, f.target.id, request)).rejects.toMatchObject({ code: 'RESEARCH_PLAN_CONFLICT' })
    expect((await f.store.getPlan(f.session, f.target.id, { planId: 1 })).latestRevision).toBe(1)
    expect(await readFile(path.join(f.root, relative), 'utf8')).toBe(valid.markdown)
    expect(await readFile(path.join(f.root, planLedgerPath(f.target.id, 1)), 'utf8')).toBe(ledgerBefore)
  })

  it('does not rebase a stale ledger CAS and leaves its exact generated snapshot recoverable', async () => {
    const f = await fixture()
    await f.store.createPlan(f.session, f.target.id, INPUT)
    const relative = planLedgerPath(f.target.id, 1)
    const originalText = await readFile(path.join(f.root, relative), 'utf8')
    const newerText = originalText.replace('{', '{  ')
    const originalWrite = f.ctx.fs.writeText.bind(f.ctx.fs)
    let ledgerWrites = 0
    vi.spyOn(f.ctx.fs, 'writeText').mockImplementation(async (...args) => {
      const file = (args[0] as unknown as { path: string }).path
      if (file === path.join(f.root, relative) && args[2]?.kind === 'replaceIfVersion') {
        ledgerWrites += 1
        if (ledgerWrites === 1) await writeFile(file, newerText)
      }
      return await originalWrite(...args)
    })
    const request = { planId: 1, expectedRevision: 1, ...UPDATED }
    await expect(f.store.updatePlan(f.session, f.target.id, request)).rejects.toMatchObject({ code: 'RESEARCH_STALE_WRITE' })
    expect(ledgerWrites).toBe(1)
    expect(await readFile(path.join(f.root, relative), 'utf8')).toBe(newerText)
    const orphan = await readFile(path.join(f.root, planVersionPath(f.target.id, 1, 2)), 'utf8')
    const recovered = await f.store.updatePlan(f.session, f.target.id, request)
    expect(recovered.plan.markdown).toBe(orphan)
    expect((await readFile(path.join(f.root, relative), 'utf8')).startsWith(newerText)).toBe(true)
  })

  it('serializes creates and stale updates from workspace aliases under the existing target lock', async () => {
    const f = await fixture()
    const alias = testSession(f.root + '/.', 'alias/session')
    const created = await Promise.all([f.store.createPlan(f.session, f.target.id, INPUT), f.store.createPlan(alias, f.target.id, UPDATED)])
    expect(created.map(value => value.plan.metadata.plan_id).sort()).toEqual([1, 2])
    const updates = await Promise.allSettled([
      f.store.updatePlan(f.session, f.target.id, { planId: 1, expectedRevision: 1, ...UPDATED }),
      f.store.updatePlan(alias, f.target.id, { planId: 1, expectedRevision: 1, ...UPDATED, delta: ['Distinct competing update'] }),
    ])
    expect(updates.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    const failed = updates.find(value => value.status === 'rejected')
    expect(failed?.status === 'rejected' ? failed.reason : undefined).toMatchObject({ code: 'RESEARCH_STALE_WRITE' })
    expect((await f.store.getPlan(f.session, f.target.id, { planId: 1 })).latestRevision).toBe(2)
    expect((await readdir(path.join(f.root, planDirectory(f.target.id, 1)))).sort()).toEqual(['v0001.md', 'v0002.md', 'versions.jsonl'])
  })

  it('verifies registered history before accepting an idempotent retry and isolates bad latest plans in lists', async () => {
    const f = await fixture()
    const created = await f.store.createPlan(f.session, f.target.id, INPUT)
    const request = { planId: 1, expectedRevision: 1, ...UPDATED }
    const updated = await f.store.updatePlan(f.session, f.target.id, request)
    const ledger = await readFile(path.join(f.root, planLedgerPath(f.target.id, 1)), 'utf8')
    await writeFile(path.join(f.root, created.path), created.plan.markdown + '\n')
    await expect(f.store.getPlan(f.session, f.target.id, { planId: 1, revision: 1 })).rejects.toThrow(/SHA-256/u)
    await expect(f.store.updatePlan(f.session, f.target.id, request)).rejects.toThrow(/SHA-256/u)
    expect(await readFile(path.join(f.root, planLedgerPath(f.target.id, 1)), 'utf8')).toBe(ledger)
    await writeFile(path.join(f.root, updated.path), updated.plan.markdown + '\n')
    const listed = await f.store.listPlans(f.session, f.target.id)
    expect(listed.plans).toEqual([])
    expect(listed.invalid).toMatchObject([{ planId: 1, code: 'RESEARCH_INVALID_RECORD' }])
  })
})

describe('explicit plan selection and run provenance', () => {
  it('keeps selection distinct from latest and preserves other state fields when explicitly selecting old or new versions', async () => {
    const f = await selectedFixture()
    const selectedRef = { planId: 1, revision: 1, sha256: f.created.plan.sha256 }
    expect(f.selected.state.selectedPlanRef).toEqual(selectedRef)
    expect(f.selected.state).toMatchObject({ status: f.target.state.status, summary: f.target.state.summary, direction: f.target.state.direction, next: f.target.state.next })
    const before = await stateBytes(f)
    const newer = await f.store.updatePlan(f.session, f.target.id, { planId: 1, expectedRevision: 1, ...UPDATED })
    expect(await stateBytes(f)).toBe(before)
    const target = await f.store.readTarget(f.session, f.target.id)
    expect(target.state.selectedPlanRef).toEqual(selectedRef)
    expect(target.selectedPlan).toMatchObject({ ref: selectedRef, path: f.created.path })
    expect((await f.store.getPlan(f.session, f.target.id, { planId: 1 })).latestRevision).toBe(2)
    await expect(f.store.selectPlan(f.session, f.target.id, { planId: 1, revision: 2, expectedStateRevision: f.target.state.revision })).rejects.toMatchObject({ code: 'RESEARCH_STALE_WRITE' })
    const selectedNew = await f.store.selectPlan(f.session, f.target.id, { planId: 1, revision: 2, expectedStateRevision: target.state.revision })
    expect(selectedNew.state.selectedPlanRef).toEqual({ planId: 1, revision: 2, sha256: newer.plan.sha256 })
    const selectedOld = await f.store.selectPlan(f.session, f.target.id, { planId: 1, revision: 1, expectedStateRevision: selectedNew.state.revision })
    expect(selectedOld.state.selectedPlanRef).toEqual(selectedRef)
    const updatedState = await f.store.appendState(f.session, f.target.id, { status: 'paused', summary: 'Pause without losing selected proposal' })
    expect(updatedState.state.selectedPlanRef).toEqual(selectedRef)
    expect((await f.store.resumeState(f.session, f.target.id)).state.selectedPlanRef).toEqual(selectedRef)
  })

  it.each(['paused', 'blocked'] as const)('allows candidate publication and selection without resuming %s research', async status => {
    const f = await fixture()
    const paused = await f.store.appendState(f.session, f.target.id, { status, summary: 'Reconsider route' })
    await f.store.createPlan(f.session, f.target.id, INPUT)
    await f.store.updatePlan(f.session, f.target.id, { planId: 1, expectedRevision: 1, ...UPDATED })
    const selected = await f.store.selectPlan(f.session, f.target.id, { planId: 1, revision: 2, expectedStateRevision: paused.state.revision })
    expect(selected.state.status).toBe(status)
    await expect(f.store.startRun(f.session, f.target.id, startRequest({ planId: 1, revision: 2 }))).rejects.toMatchObject({ code: 'RESEARCH_TARGET_INACTIVE' })
    expect(f.checkpoints.start).not.toHaveBeenCalled()
  })

  it('allows completed-target reads and verified no-write retries but no new publications or selections', async () => {
    const f = await selectedFixture()
    const request = { planId: 1, expectedRevision: 1, ...UPDATED }
    await f.store.updatePlan(f.session, f.target.id, request)
    const completed = await f.store.appendState(f.session, f.target.id, { status: 'complete', summary: 'Research complete' })
    const write = vi.spyOn(f.ctx.fs, 'writeText')
    expect((await f.store.updatePlan(f.session, f.target.id, request)).latestRevision).toBe(2)
    expect(write).not.toHaveBeenCalled()
    await expect(f.store.createPlan(f.session, f.target.id, INPUT)).rejects.toMatchObject({ code: 'RESEARCH_TARGET_COMPLETE' })
    await expect(f.store.updatePlan(f.session, f.target.id, { ...request, expectedRevision: 2 })).rejects.toMatchObject({ code: 'RESEARCH_TARGET_COMPLETE' })
    await expect(f.store.selectPlan(f.session, f.target.id, { planId: 1, revision: 2, expectedStateRevision: completed.state.revision })).rejects.toMatchObject({ code: 'RESEARCH_TARGET_COMPLETE' })
    expect((await f.store.listPlans(f.session, f.target.id)).plans).toHaveLength(1)
    expect((await f.store.getPlan(f.session, f.target.id, { planId: 1 })).latestRevision).toBe(2)
  })

  it('refuses absent/unselected/mismatched/corrupt plans before any input checkpoint or new run record', async () => {
    const f = await fixture()
    const { plan: _plan, ...withoutPlan } = startRequest()
    await expect(f.store.startRun(f.session, f.target.id, withoutPlan as StartResearchRunRequest)).rejects.toMatchObject({ code: 'RESEARCH_PLAN_REQUIRED' })
    const created = await f.store.createPlan(f.session, f.target.id, INPUT)
    await expect(f.store.startRun(f.session, f.target.id, startRequest())).rejects.toMatchObject({ code: 'RESEARCH_PLAN_REQUIRED' })
    await f.store.selectPlan(f.session, f.target.id, { planId: 1, revision: 1, expectedStateRevision: f.target.state.revision })
    await expect(f.store.startRun(f.session, f.target.id, startRequest({ planId: 1, revision: 2 }))).rejects.toMatchObject({ code: 'RESEARCH_PLAN_CONFLICT' })
    await writeFile(path.join(f.root, created.path), created.plan.markdown + '\n')
    await expect(f.store.startRun(f.session, f.target.id, startRequest())).rejects.toThrow(/SHA-256/u)
    expect(f.checkpoints.start).not.toHaveBeenCalled()
    expect(await readdir(path.join(f.root, f.target.root, 'runs'))).toEqual([])
    expect((await f.store.readTarget(f.session, f.target.id)).warnings.join('\n')).toContain('Selected plan integrity error')
  })

  it('pins the selected historical revision and hash through v3 description, result, and prepared state', async () => {
    const f = await selectedFixture()
    await f.store.updatePlan(f.session, f.target.id, { planId: 1, expectedRevision: 1, ...UPDATED })
    const started = await f.store.startRun(f.session, f.target.id, startRequest())
    const ref = { planId: 1, revision: 1, sha256: f.created.plan.sha256 }
    expect(started.planRef).toEqual(ref)
    expect((await f.store.readRun(f.session, f.target.id, started.runId)).description).toMatchObject({ version: 3, planRef: ref })
    await f.store.createPlan(f.session, f.target.id, { ...UPDATED, title: 'Future candidate' })
    await expect(f.store.selectPlan(f.session, f.target.id, { planId: 1, revision: 2, expectedStateRevision: f.selected.state.revision })).rejects.toMatchObject({ code: 'RESEARCH_RUN_OPEN' })
    const finished = await f.store.finishRun(f.session, f.target.id, finishRequest(started.runId))
    expect(finished.planRef).toEqual(ref)
    expect(finished.state.selectedPlanRef).toEqual(ref)
    const run = await f.store.readRun(f.session, f.target.id, started.runId)
    expect(run.result).toMatchObject({ version: 3, planRef: ref, transition: { selectedPlanRef: ref } })
    expect(f.checkpoints.sealed.get(started.checkpoint.outputRef)?.prepared).toMatchObject({ version: 3, planRef: ref, transition: { selectedPlanRef: ref } })
    expect((await f.store.getPlan(f.session, f.target.id, { planId: 1 })).latestRevision).toBe(2)
  })

  it('blocks selection during a legacy open run but still finishes it without inventing plan provenance', async () => {
    const f = await fixture()
    await f.store.createPlan(f.session, f.target.id, INPUT)
    const runId = parseRunId('123e4567-e89b-42d3-a456-426614174099')
    const description = researchRunDescriptionSchema.parse({ version: 1, type: 'description', createdAt: '2025-01-01T00:00:00.000Z', sessionId: String(f.session.id), purpose: 'Legacy unplanned execution', parameters: {} })
    await writeFile(path.join(f.root, runPath(f.target.id, runId)), renderOpenRun(description))
    await expect(f.store.selectPlan(f.session, f.target.id, { planId: 1, revision: 1, expectedStateRevision: f.target.state.revision })).rejects.toMatchObject({ code: 'RESEARCH_RUN_OPEN' })
    const finished = await f.store.finishRun(f.session, f.target.id, finishRequest(runId))
    expect(finished.planRef).toBeUndefined()
    expect(finished.state.selectedPlanRef).toBeUndefined()
    expect((await f.store.readRun(f.session, f.target.id, runId)).result?.version).toBe(1)
    expect(f.checkpoints.finish).not.toHaveBeenCalled()
  })

  it('requires the pinned file to verify before first output capture and does not seal a corrupted plan', async () => {
    const f = await selectedFixture()
    const started = await f.store.startRun(f.session, f.target.id, startRequest())
    await writeFile(path.join(f.root, f.created.path), f.created.plan.markdown + '\n')
    await expect(f.store.finishRun(f.session, f.target.id, finishRequest(started.runId))).rejects.toThrow(/SHA-256/u)
    expect(f.checkpoints.sealed.size).toBe(0)
    expect((await f.store.readRun(f.session, f.target.id, started.runId)).result).toBeUndefined()
    expect((await f.store.readTarget(f.session, f.target.id)).state.revision).toBe(f.selected.state.revision)
    await writeFile(path.join(f.root, f.created.path), f.created.plan.markdown)
    expect((await f.store.finishRun(f.session, f.target.id, finishRequest(started.runId))).planRef).toEqual(started.planRef)
  })

  it.each(['run', 'state'] as const)('recovers after %s publication failure from the original seal even when artifacts and plan integrity change', async boundary => {
    const f = await selectedFixture()
    const started = await f.store.startRun(f.session, f.target.id, startRequest())
    await writeFile(path.join(f.root, 'result.json'), '{"error":0.3}\n')
    const request = finishRequest(started.runId, ['result.json'])
    const failing = boundary === 'run' ? started.path : statePath(f.target.id)
    await failNextWrite(f.ctx, failing, 'publication interrupted', 'replaceIfVersion')
    await expect(f.store.finishRun(f.session, f.target.id, request)).rejects.toThrow('publication interrupted')
    const saved = structuredClone(f.checkpoints.sealed.get(started.checkpoint.outputRef)!)
    expect(saved).toBeDefined()
    await rm(path.join(f.root, 'result.json'))
    await writeFile(path.join(f.root, f.created.path), 'not valid plan Markdown anymore')
    const fresh = new ResearchStore(testContext(f.root), f.checkpoints)
    const freshSession = testSession(f.root, 'recovery/session')
    const target = await fresh.readTarget(freshSession, f.target.id)
    expect(target.recovery).toMatchObject({ runId: started.runId, phase: boundary === 'run' ? 'open' : 'pending-state', planRef: started.planRef })
    expect(target.warnings.join('\n')).toContain('Selected plan integrity error')
    await expect(fresh.selectPlan(freshSession, f.target.id, { planId: 1, revision: 1, expectedStateRevision: target.state.revision })).rejects.toMatchObject({ code: 'RESEARCH_RUN_OPEN' })
    await expect(fresh.finishRun(freshSession, f.target.id, { ...request, result: 'changed retry' })).rejects.toMatchObject({ code: 'RESEARCH_RUN_CLOSED' })
    const finished = await fresh.finishRun(freshSession, f.target.id, request)
    expect(finished.state).toEqual(saved.prepared.transition)
    expect(finished.planRef).toEqual(started.planRef)
    const bytes = await stateBytes(f)
    expect((await fresh.finishRun(freshSession, f.target.id, request)).state).toEqual(finished.state)
    expect(await stateBytes(f)).toBe(bytes)
    expect((await fresh.readTarget(freshSession, f.target.id)).recovery).toBeUndefined()
    const closed = await fresh.readRun(freshSession, f.target.id, started.runId)
    expect(closed.result).toMatchObject({ version: 3, planRef: started.planRef, transition: saved.prepared.transition })
  })
})
