import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { onTestFinished } from 'vitest'
import { ResearchStore } from '../src/research-store.ts'
import { RecordStore } from '../src/record-store.ts'
import { researchViewConfigSchema } from '../src/view-config.ts'
import { readResearchViewData } from '../src/view-data.ts'
import type { ResearchViewConfig, ResearchViewRequest, ResearchViewTargetToken } from '../src/view-types.ts'
import type { RunId } from '../src/types.ts'
import { mockCheckpoints, testContext, testReproduction, testSession } from './helpers.ts'

export const viewConfig = researchViewConfigSchema.parse({ enabled: true })
export const viewToken = 'view_test_target' as ResearchViewTargetToken
export const viewRequest = (patch: Partial<ResearchViewRequest> = {}): ResearchViewRequest => ({ sessionId: 'view/test', planId: 1, ...patch })
export const planContent = { title: '估计器方案', body: 'Measure estimator error against the recorded baseline.', delta: ['初始方案'] }
export async function viewFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'researcher-view-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = testContext(root)
  const store = new ResearchStore(ctx, mockCheckpoints())
  const session = testSession(root)
  const target = await store.createTarget(session, { goal: '研究方案与实验的真实关系', metrics: ['evidence remains exact'], baseline: 'initial plan' })
  const initial = await store.createPlan(session, target.id, planContent)
  const records = new RecordStore(ctx)
  const read = (config: ResearchViewConfig = viewConfig, signal?: AbortSignal) => readResearchViewData(records, { workspaceRoot: root }, target.id, config, signal)
  const addVersion = (planId: number, expectedRevision: number, basis: readonly { runId: RunId; reason: string }[] = []) => store.updatePlan(session, target.id, {
    ...planContent, title: '估计器 v' + (expectedRevision + 1), delta: ['修订' + expectedRevision], planId, expectedRevision, basedOnRuns: [...basis],
  })
  const addRun = async (planId = 1, revision = 1, status: 'completed' | 'failed' | 'open' = 'completed') => {
    const latest = await store.readTarget(session, target.id)
    await store.selectPlan(session, target.id, { planId, revision, expectedStateRevision: latest.state.revision })
    const started = await store.startRun(session, target.id, { plan: { planId, revision }, purpose: '测量误差', parameters: { seed: 7 }, reproduction: testReproduction() })
    if (status !== 'open') await store.finishRun(session, target.id, { runId: started.runId, status, result: '结果未改善', metrics: { error: 0.3 }, decision: '据此修订', artifacts: [], researchStatus: 'active', summary: '实验记录完成' })
    return started
  }
  return { root, ctx, store, session, target, initial, records, read, addVersion, addRun }
}
/** Every page fixture is created through research authority APIs, not hand-authored run records. */
export async function populatedViewFixture(versions = 3, runsPerVersion = 4, causal = true) {
  const f = await viewFixture()
  const runs: RunId[][] = []
  for (let revision = 1; revision <= versions; revision++) {
    if (revision > 1) await f.addVersion(1, revision - 1, causal ? [{ runId: runs[revision - 2]![0]!, reason: '误差促成修订' }] : [])
    const group: RunId[] = []
    for (let i = 0; i < runsPerVersion; i++) group.push((await f.addRun(1, revision)).runId)
    runs.push(group)
  }
  return { ...f, runs }
}
