import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchStore } from '../src/research-store.ts'
import { planContentInputSchema, planMetadataSchema } from '../src/plan-schema.ts'
import { parsePlanDocument, planContentMatches, planLedgerPath, planVersionPath, renderPlanDocument } from '../src/plan-records.ts'
import { runPath, statePath } from '../src/record-store.ts'
import { parseRunId } from '../src/schema.ts'
import type { FinishResearchRunRequest, RunId } from '../src/types.ts'
import { failNextWrite, makeWorkspace, mockCheckpoints, removeWorkspace, testContext, testReproduction, testSession } from './helpers.ts'

const CONTENT = { title: 'Compare estimators', body: 'Evaluate the estimator against a fixed baseline.', delta: ['Initial proposal'] }
const AT = '2025-01-01T00:00:00.000Z'
const RUN_ID = parseRunId('123e4567-e89b-42d3-a456-426614174099')
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await removeWorkspace(root)
})

async function fixture() {
  const root = await makeWorkspace('researcher-plan-evidence'); roots.push(root)
  const ctx = testContext(root)
  const store = new ResearchStore(ctx, mockCheckpoints())
  const session = testSession(root)
  const target = await store.createTarget(session, { goal: 'Explain each revision with recorded experiment evidence.', metrics: ['preserve references'], baseline: 'no revisions' })
  const original = await store.createPlan(session, target.id, CONTENT)
  await store.selectPlan(session, target.id, { planId: 1, revision: 1, expectedStateRevision: target.state.revision })
  const started = await store.startRun(session, target.id, { plan: { planId: 1, revision: 1 }, purpose: 'Measure estimator error', parameters: { seed: 7 }, reproduction: testReproduction() })
  return { root, ctx, store, session, target, original, started }
}
function finish(runId: RunId, status: 'completed' | 'failed' = 'completed'): FinishResearchRunRequest {
  return { runId, status, result: 'The observed error did not improve.', metrics: { error: 0.3 }, decision: 'Revise the estimator.', artifacts: [], researchStatus: 'active', summary: 'Evaluation recorded.' }
}
const basis = (runId: RunId) => [{ runId, reason: 'The measured error motivates a revised estimator.' }]
const revision = (runId: RunId) => ({ ...CONTENT, planId: 1, expectedRevision: 1, title: 'Revised estimator', delta: ['Change estimator'], basedOnRuns: basis(runId) })

describe('immutable experiment evidence in plan documents', () => {
  it('reads v1 bytes unchanged and writes explicit v2 evidence without inheriting it', () => {
    const legacy = renderPlanDocument(1, 1, CONTENT, AT, [], 1)
    expect(parsePlanDocument(legacy.markdown)).toEqual(legacy)
    expect(legacy.metadata.schema_version).toBe(1)
    expect(planContentMatches(legacy, CONTENT)).toBe(true)
    expect(planContentMatches(legacy, { ...CONTENT, basedOnRuns: basis(RUN_ID) })).toBe(false)
    const input = { ...CONTENT, basedOnRuns: basis(RUN_ID) }
    const evidence = [{ run_id: RUN_ID, reason: input.basedOnRuns[0]!.reason, sha256: 'a'.repeat(64) }]
    const next = renderPlanDocument(1, 2, input, AT, evidence)
    expect(next.metadata).toMatchObject({ schema_version: 2, based_on_runs: evidence })
    expect(planContentMatches(next, input)).toBe(true)
    expect(planContentMatches(next, CONTENT)).toBe(false)
    expect(planContentMatches(next, { ...input, basedOnRuns: [{ runId: RUN_ID, reason: 'Another reason' }] })).toBe(false)
    expect(renderPlanDocument(1, 3, CONTENT, AT).metadata).toMatchObject({ based_on_runs: [] })
    expect(legacy.sha256).toBe(createHash('sha256').update(legacy.markdown).digest('hex'))
  })

  it('rejects duplicate, blank and caller-supplied hash fields', () => {
    expect(planContentInputSchema.safeParse({ ...CONTENT, basedOnRuns: [...basis(RUN_ID), ...basis(RUN_ID)] }).success).toBe(false)
    expect(planContentInputSchema.safeParse({ ...CONTENT, basedOnRuns: [{ runId: RUN_ID, reason: ' ' }] }).success).toBe(false)
    expect(planContentInputSchema.safeParse({ ...CONTENT, basedOnRuns: [{ ...basis(RUN_ID)[0], sha256: 'a'.repeat(64) }] }).success).toBe(false)
    const document = renderPlanDocument(1, 1, CONTENT, AT)
    expect(planMetadataSchema.safeParse({ ...document.metadata, based_on_runs: [{ run_id: RUN_ID, reason: 'Reason', sha256: 'a'.repeat(64) }] }).success).toBe(false)
    expect(() => renderPlanDocument(1, 2, { ...CONTENT, basedOnRuns: basis(RUN_ID) }, AT)).toThrow(/resolved experiment evidence/u)
  })
})

describe('ResearchStore experiment basis validation', () => {
  it.each(['completed', 'failed'] as const)('pins %s experiments without selecting a new version or rewriting history', async status => {
    const f = await fixture()
    await f.store.finishRun(f.session, f.target.id, finish(f.started.runId, status))
    const originalPath = path.join(f.root, f.original.path)
    const originalBytes = await readFile(originalPath, 'utf8')
    const stateBefore = await readFile(path.join(f.root, statePath(f.target.id)), 'utf8')
    const runBytes = await readFile(path.join(f.root, runPath(f.target.id, f.started.runId)), 'utf8')
    const revised = await f.store.updatePlan(f.session, f.target.id, revision(f.started.runId))
    expect(revised.plan.metadata).toMatchObject({ schema_version: 2, based_on_runs: [{ run_id: f.started.runId, reason: basis(f.started.runId)[0]!.reason, sha256: createHash('sha256').update(runBytes).digest('hex') }] })
    expect(await f.store.updatePlan(f.session, f.target.id, revision(f.started.runId))).toEqual(revised)
    expect(await readFile(originalPath, 'utf8')).toBe(originalBytes)
    expect(await readFile(path.join(f.root, statePath(f.target.id)), 'utf8')).toBe(stateBefore)
    const third = await f.store.updatePlan(f.session, f.target.id, { ...CONTENT, planId: 1, expectedRevision: 2 })
    expect(third.plan.metadata).toMatchObject({ based_on_runs: [] })
  })

  it('requires a sealed Run and a published state transition', async () => {
    const f = await fixture()
    await expect(f.store.updatePlan(f.session, f.target.id, revision(f.started.runId))).rejects.toMatchObject({ code: 'RESEARCH_PLAN_EVIDENCE' })
    await failNextWrite(f.ctx, statePath(f.target.id), 'state publication interrupted')
    await expect(f.store.finishRun(f.session, f.target.id, finish(f.started.runId))).rejects.toThrow('state publication interrupted')
    await expect(f.store.updatePlan(f.session, f.target.id, revision(f.started.runId))).rejects.toMatchObject({ code: 'RESEARCH_PLAN_EVIDENCE' })
    await f.store.finishRun(f.session, f.target.id, finish(f.started.runId))
    await expect(f.store.updatePlan(f.session, f.target.id, revision(f.started.runId))).resolves.toMatchObject({ latestRevision: 2 })
  })

  it('does not accept missing or another plan’s experiments, or evidence on an initial plan', async () => {
    const f = await fixture()
    await f.store.finishRun(f.session, f.target.id, finish(f.started.runId))
    await expect(f.store.updatePlan(f.session, f.target.id, revision(RUN_ID))).rejects.toThrow()
    await expect(f.store.createPlan(f.session, f.target.id, { ...CONTENT, basedOnRuns: basis(f.started.runId) })).rejects.toMatchObject({ code: 'RESEARCH_PLAN_EVIDENCE' })
    const second = await f.store.createPlan(f.session, f.target.id, CONTENT)
    await expect(f.store.updatePlan(f.session, f.target.id, { ...revision(f.started.runId), planId: second.plan.metadata.plan_id })).rejects.toMatchObject({ code: 'RESEARCH_PLAN_EVIDENCE' })
  })

  it('rejects identical-value Run byte changes instead of silently replacing the recorded digest', async () => {
    const f = await fixture()
    await f.store.finishRun(f.session, f.target.id, finish(f.started.runId))
    const updated = await f.store.updatePlan(f.session, f.target.id, revision(f.started.runId))
    const file = path.join(f.root, runPath(f.target.id, f.started.runId))
    const text = await readFile(file, 'utf8')
    await writeFile(file, text.replace('"purpose":', '"purpose": '))
    await expect(f.store.getPlan(f.session, f.target.id, { planId: 1, revision: 2 })).rejects.toMatchObject({ code: 'RESEARCH_PLAN_INTEGRITY' })
    expect(await readFile(path.join(f.root, updated.path), 'utf8')).toBe(updated.plan.markdown)
  })

  it('recovers an interrupted evidence-bearing publication with the original timestamp and bytes', async () => {
    const f = await fixture()
    await f.store.finishRun(f.session, f.target.id, finish(f.started.runId))
    await failNextWrite(f.ctx, planLedgerPath(f.target.id, 1), 'ledger publication interrupted')
    await expect(f.store.updatePlan(f.session, f.target.id, revision(f.started.runId))).rejects.toThrow('ledger publication interrupted')
    const nextFile = path.join(f.root, planVersionPath(f.target.id, 1, 2))
    const pending = await readFile(nextFile, 'utf8')
    await expect(f.store.updatePlan(f.session, f.target.id, { ...revision(f.started.runId), basedOnRuns: [{ runId: f.started.runId, reason: 'Changed explanation' }] })).rejects.toMatchObject({ code: 'RESEARCH_PLAN_CONFLICT' })
    const recovered = await f.store.updatePlan(f.session, f.target.id, revision(f.started.runId))
    expect(recovered.plan.markdown).toBe(pending)
    expect(await readFile(nextFile, 'utf8')).toBe(pending)
    expect((await readFile(path.join(f.root, planLedgerPath(f.target.id, 1)), 'utf8')).trim().split('\n')).toHaveLength(2)
  })
})
