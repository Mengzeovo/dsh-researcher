import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runPath, statePath } from '../src/record-store.ts'
import { planNodeId, projectResearchView, runNodeId } from '../src/view-projection.ts'
import type { ResearchViewData } from '../src/view-types.ts'
import { planContent, populatedViewFixture, viewConfig, viewFixture, viewRequest, viewToken } from './view-test-helpers.ts'

afterEach(() => vi.restoreAllMocks())
const project = (data: ResearchViewData, request = viewRequest(), config = viewConfig) => projectResearchView(data, viewToken, request, config)

describe('research view projection', () => {
  it('shows exactly three versions and twelve experiments with authored causal edges and no session/result nodes', async () => {
    const f = await populatedViewFixture()
    await f.store.createPlan(f.session, f.target.id, { ...planContent, title: 'Second partition' })
    const data = await f.read()
    const { snapshot, details } = project(data)
    expect(snapshot.groups.map(group => group.planId)).toEqual([1, 2])
    expect(snapshot.nodes).toHaveLength(15)
    expect(new Set(snapshot.nodes.map(node => node.id)).size).toBe(15)
    expect(new Set(snapshot.nodes.map(node => node.kind))).toEqual(new Set(['plan', 'run']))
    expect(snapshot.nodes.filter(node => node.kind === 'plan').map(node => [node.id, node.column])).toEqual([[planNodeId(1, 1), 0], [planNodeId(1, 2), 2], [planNodeId(1, 3), 4]])
    for (const node of snapshot.nodes.filter(node => node.kind === 'run')) {
      expect(node.column).toBe((node.revision - 1) * 2 + 1)
      expect(node.slot).toBeGreaterThanOrEqual(0); expect(node.slot).toBeLessThan(4)
      expect(details.get(node.id)?.kind).toBe('run')
    }
    expect(snapshot.edges.filter(edge => edge.kind === 'uses-plan')).toHaveLength(12)
    expect(snapshot.edges.filter(edge => edge.kind === 'informs-plan')).toEqual([
      expect.objectContaining({ from: runNodeId(f.runs[0]![0]!), to: planNodeId(1, 2), label: '误差促成修订' }),
      expect.objectContaining({ from: runNodeId(f.runs[1]![0]!), to: planNodeId(1, 3), label: '误差促成修订' }),
    ])
    // Experiment-driven revisions never also carry a direct revision-lineage edge.
    expect(snapshot.edges.filter(edge => edge.kind === 'revises-plan')).toHaveLength(0)
    expect(snapshot.nodes.every(node => node.planId === 1)).toBe(true)
    expect(project(data, viewRequest({ planId: 2 })).snapshot.nodes.map(node => node.id)).toEqual([planNodeId(2, 1)])
  }, 60000)

  it('keeps four revisions and causal edges continuous while Run subpages remain navigable', async () => {
    const f = await populatedViewFixture(4, 1)
    const data = await f.read()
    const first = project(data).snapshot
    expect(first.nodes.filter(node => node.kind === 'plan').map(node => [node.revision, node.column])).toEqual([[1, 0], [2, 2], [3, 4], [4, 6]])
    expect(first.nodes).toHaveLength(8)
    expect(first.edges.filter(edge => edge.kind === 'informs-plan')).toHaveLength(3)
    expect(first.outsideLinks).toEqual([])
    expect(project(data, { sessionId: 'view/test' }).snapshot).toEqual(first)

    for (let i = 0; i < 4; i++) await f.addRun(1, 1)
    const expanded = await f.read()
    const runPage = project(expanded, viewRequest({ runPages: { 1: 1 } })).snapshot
    const hiddenBasis = runPage.outsideLinks.find(item => item.nodeId === runNodeId(f.runs[0]![0]!))!
    expect(hiddenBasis.selection).toMatchObject({ planId: 1, runPages: { 1: 0 } })
    expect(runPage.nodes.filter(node => node.kind === 'run' && node.revision === 1)).toHaveLength(1)
    expect(runPage.nodes.some(node => node.id === hiddenBasis.nodeId)).toBe(false)
    const restored = project(expanded, viewRequest({ ...hiddenBasis.selection, planId: hiddenBasis.selection.planId! })).snapshot
    expect(restored.nodes.some(node => node.id === hiddenBasis.nodeId)).toBe(true)
    expect(new Set(restored.nodes.map(node => node.id)).size).toBe(restored.nodes.length)
  }, 60000)

  it('links discussion-driven revisions directly with their authored change notes', async () => {
    const f = await populatedViewFixture(2, 1, false)
    const data = await f.read()
    const edges = project(data).snapshot.edges
    expect(edges.every(edge => edge.kind !== 'informs-plan')).toBe(true)
    expect(edges.filter(edge => edge.kind === 'revises-plan')).toEqual([
      { id: 'revises_1_v2', kind: 'revises-plan', from: planNodeId(1, 1), to: planNodeId(1, 2), label: '修订1' },
    ])
  }, 30000)

  it('does not infer causal edges from timestamps or assign legacy/mismatched runs to a synthetic plan', async () => {
    const f = await populatedViewFixture(2, 1, false)
    const data = await f.read()
    const first = data.runs[0]!
    if (first.run.description.version !== 3) throw new Error('fixture requires plan run')
    const { planRef: _ref, ...description } = first.run.description
    const legacy = { ...first, run: { id: first.run.id, description: { ...description, version: 2 as const } } }
    const old = project({ ...data, runs: [legacy] }).snapshot
    expect(old.nodes.every(node => node.kind === 'plan')).toBe(true)
    expect(old.groups.map(group => group.planId)).toEqual([1])
    expect(old.diagnostics).toContainEqual(expect.objectContaining({ code: 'RUN_WITHOUT_PLAN' }))
    const bad = project({ ...data, runs: [{ ...first, run: { ...first.run, description: { ...first.run.description, planRef: { ...first.run.description.planRef, sha256: 'a'.repeat(64) } } } }] }).snapshot
    expect(bad.nodes.every(node => node.kind === 'plan')).toBe(true)
    expect(bad.diagnostics).toContainEqual(expect.objectContaining({ code: 'RUN_PLAN_INTEGRITY' }))
  }, 30000)

  it('keeps all discussion-driven lineage edges in the graph, even across the former page boundary', async () => {
    const f = await populatedViewFixture(4, 1, false)
    const data = await f.read()
    const snapshot = project(data).snapshot
    expect(snapshot.edges.filter(edge => edge.kind === 'revises-plan').map(edge => edge.id)).toEqual(['revises_1_v2', 'revises_1_v3', 'revises_1_v4'])
    expect(snapshot.outsideLinks).toEqual([])
    const sparse = project({ ...data, plans: data.plans.filter(plan => plan.document.metadata.revision !== 2) }).snapshot
    expect(sparse.nodes.filter(node => node.kind === 'plan').map(node => [node.revision, node.column])).toEqual([[1, 0], [3, 2], [4, 4]])
    expect(sparse.edges.filter(edge => edge.kind === 'revises-plan').map(edge => edge.id)).toEqual(['revises_1_v4'])
  }, 60000)

  it('does not create partitions from missing plan references in valid Run records', async () => {
    const f = await viewFixture()
    const started = await f.addRun(1, 1, 'open')
    const file = path.join(f.root, runPath(f.target.id, started.runId))
    const description = JSON.parse((await readFile(file, 'utf8')).trim()) as Record<string, unknown>
    for (const patch of [{ planId: 999 }, { revision: 999 }, { sha256: 'f'.repeat(64) }]) {
      await writeFile(file, JSON.stringify({ ...description, planRef: { ...(description.planRef as Record<string, unknown>), ...patch } }) + '\n')
      const snapshot = project(await f.read()).snapshot
      expect(snapshot.nodes.every(node => node.kind === 'plan')).toBe(true)
      expect(snapshot.groups.map(group => group.planId)).toEqual([1])
      expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: 'RUN_PLAN_INTEGRITY' }))
    }
  })

  it('keeps healthy partitions accessible when selected state names a nonexistent plan', async () => {
    const f = await viewFixture()
    await f.addRun(1, 1, 'open')
    const file = path.join(f.root, statePath(f.target.id))
    const rows = (await readFile(file, 'utf8')).trim().split('\n')
    const selected = JSON.parse(rows.at(-1)!) as Record<string, unknown>
    rows[rows.length - 1] = JSON.stringify({ ...selected, selectedPlanRef: { ...(selected.selectedPlanRef as Record<string, unknown>), planId: 999 } })
    await writeFile(file, rows.join('\n') + '\n')
    const snapshot = project(await f.read(), { sessionId: 'view/test' }).snapshot
    expect(snapshot.groups.map(group => group.planId)).toEqual([1])
    expect(snapshot.selection.planId).toBe(1)
    expect(snapshot.nodes).toHaveLength(2)
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: 'SELECTED_PLAN_INTEGRITY' }))
  })

  it('requires exact evidence SHA and a committed source before drawing a causal edge', async () => {
    const f = await populatedViewFixture(2, 1)
    const data = await f.read()
    const sourceId = f.runs[0]![0]!
    for (const altered of [{ committed: false }, { sha256: 'f'.repeat(64) }]) {
      const next = project({ ...data, runs: data.runs.map(record => record.run.id === sourceId ? { ...record, ...altered } : record) }).snapshot
      expect(next.edges.filter(edge => edge.kind === 'informs-plan')).toHaveLength(0)
      expect(next.diagnostics).toContainEqual(expect.objectContaining({ code: 'PLAN_EVIDENCE_INTEGRITY', nodeId: planNodeId(1, 2) }))
      expect(next.nodes).toHaveLength(4)
    }
  }, 30000)

  it('distinguishes unsealed, execution-failed and completed-but-state-pending runs', async () => {
    const f = await viewFixture()
    const failed = await f.addRun(1, 1, 'failed')
    const completed = await f.addRun()
    const open = await f.addRun(1, 1, 'open')
    const data = await f.read()
    const snapshot = project({ ...data, runs: data.runs.map(record => record.run.id === completed.runId ? { ...record, committed: false } : record) }).snapshot
    expect(snapshot.nodes.find(node => node.id === runNodeId(failed.runId))).toMatchObject({ status: 'failed', pendingState: false })
    expect(snapshot.nodes.find(node => node.id === runNodeId(completed.runId))).toMatchObject({ status: 'completed', pendingState: true })
    expect(snapshot.nodes.find(node => node.id === runNodeId(open.runId))).toMatchObject({ status: 'unsealed', pendingState: false })
  }, 30000)

  it('uses snapshot identities that track publications and run changes, and bounds UTF-8 responses exactly', async () => {
    const f = await viewFixture()
    const original = project(await f.read()).snapshot
    await f.addVersion(1, 1)
    const published = project(await f.read()).snapshot
    expect(published.state.revision).toBe(original.state.revision)
    expect(published.snapshotId).not.toBe(original.snapshotId)
    const started = await f.addRun()
    const beforeRunChange = project(await f.read()).snapshot
    const file = path.join(f.root, runPath(f.target.id, started.runId))
    await writeFile(file, (await readFile(file, 'utf8')).replace('测量误差', '测量更多误差'))
    const changedData = await f.read()
    const afterRunChange = project(changedData).snapshot
    expect(afterRunChange.state.revision).toBe(beforeRunChange.state.revision)
    expect(afterRunChange.snapshotId).not.toBe(beforeRunChange.snapshotId)
    const bytes = Buffer.byteLength(JSON.stringify(afterRunChange))
    expect(bytes).toBeGreaterThan(JSON.stringify(afterRunChange).length)
    expect(project(changedData, viewRequest(), { ...viewConfig, maxSnapshotBytes: bytes }).snapshot).toEqual(afterRunChange)
    expect(() => project(changedData, viewRequest(), { ...viewConfig, maxSnapshotBytes: bytes - 1 })).toThrow(expect.objectContaining({ code: 'RESEARCH_OVERSIZED' }))
    expect(() => project(changedData, viewRequest(), { ...viewConfig, maxSnapshotBytes: 1 })).toThrow(expect.objectContaining({ code: 'RESEARCH_OVERSIZED' }))
    expect(() => project(changedData, viewRequest({ planId: 99 }))).toThrow(expect.objectContaining({ code: 'RESEARCH_NOT_FOUND' }))
    expect(() => project(changedData, viewRequest({ runPages: { 1: 1 } }))).toThrow(expect.objectContaining({ code: 'RESEARCH_VIEW_PAGE' }))
  }, 30000)
})
