import { describe, expect, it } from 'vitest'
import { viewInvocations } from '../src/view-invocations.ts'
import { projectResearchView } from '../src/view-projection.ts'
import { researchViewChangedSchema, researchViewDetailSchema, researchViewNodeRequestSchema, researchViewRenderedSchema, researchViewRenderRequestSchema, researchViewRequestSchema, researchViewResponseSchema, researchViewWatchRequestSchema } from '../src/view-wire.ts'
import type { ResearchViewTargetToken } from '../src/view-types.ts'
import { viewConfig, viewFixture, viewRequest } from './view-test-helpers.ts'

const hash = 'a'.repeat(64)
const nodeRequest = { sessionId: 'view/test', snapshotId: hash, nodeId: 'plan_1_v1' }
const renderRequest = { sessionId: 'view/test', snapshotId: hash, theme: 'light', locale: 'en' }

describe('research view JSON validation', () => {
  it('rejects malformed page selections and unknown request fields', () => {
    expect(researchViewRequestSchema.parse({ sessionId: 'view/test', planId: 1, versionPage: 0, runPages: { 1: 0 }, ifNoneMatch: hash })).toMatchObject({ planId: 1 })
    for (const patch of [{ sessionId: '' }, { sessionId: '  ' }, { planId: 0 }, { planId: 1.5 }, { planId: Number.MAX_SAFE_INTEGER + 1 }, { versionPage: -1 }, { versionPage: 0.2 }, { runPages: { 0: 1 } }, { runPages: { 1: -1 } }, { runPages: { '../path': 1 } }, { ifNoneMatch: 'bad' }, { extra: true }]) {
      expect(researchViewRequestSchema.safeParse({ sessionId: 'view/test', ...patch }).success).toBe(false)
    }
    expect(researchViewWatchRequestSchema.safeParse({ sessionId: 'view/test', target: 'override' }).success).toBe(false)
  })

  it('accepts only branded-looking node references, digest strings and supported render selectors', () => {
    expect(researchViewNodeRequestSchema.safeParse(nodeRequest).success).toBe(true)
    for (const id of ['../plan/1', 'plan_0_v1', 'plan_01_v1', 'plan_1_v0', 'run_not-a-uuid', '<script>', 'session_1']) expect(researchViewNodeRequestSchema.safeParse({ ...nodeRequest, nodeId: id }).success).toBe(false)
    for (const patch of [{ snapshotId: '' }, { snapshotId: 'A'.repeat(64) }, { nodeId: null }, { path: 'v1.md' }]) expect(researchViewNodeRequestSchema.safeParse({ ...nodeRequest, ...patch }).success).toBe(false)
    expect(researchViewRenderRequestSchema.safeParse(renderRequest).success).toBe(true)
    for (const patch of [{ theme: 'auto' }, { locale: 'zh' }, { spec: {} }, { html: '<svg/>' }, { output: '../file' }]) expect(researchViewRenderRequestSchema.safeParse({ ...renderRequest, ...patch }).success).toBe(false)
  })

  it('validates actual projected snapshots and rejects malformed semantic nodes and nested extra fields', async () => {
    const f = await viewFixture(); await f.addRun()
    const { snapshot } = projectResearchView(await f.read(), hash as ResearchViewTargetToken, viewRequest(), viewConfig)
    expect(researchViewResponseSchema.parse(snapshot)).toEqual(snapshot)
    expect(researchViewResponseSchema.safeParse({ kind: 'unbound' }).success).toBe(true)
    expect(researchViewResponseSchema.safeParse({ kind: 'unchanged', snapshotId: hash }).success).toBe(true)
    const run = snapshot.nodes.find(node => node.kind === 'run')!
    for (const patch of [{ status: 'running' }, { pendingState: 'false' }, { slot: 4 }, { column: 6 }, { extra: 1 }, { metrics: { bad: Infinity } }]) {
      expect(researchViewResponseSchema.safeParse({ ...snapshot, nodes: [{ ...run, ...patch }] }).success).toBe(false)
    }
    for (const patch of [{ extra: true }, { selection: { ...snapshot.selection, extra: true } }, { state: { ...snapshot.state, selectedPlanRef: { planId: 1, revision: 1, sha256: 'bad' } } }, { pages: { ...snapshot.pages, versionsPerPage: 4 } }]) expect(researchViewResponseSchema.safeParse({ ...snapshot, ...patch }).success).toBe(false)
  })

  it('keeps opaque Run JSON inspection separate from semantic node validation', async () => {
    const f = await viewFixture(); await f.addRun()
    const projection = projectResearchView(await f.read(), hash as ResearchViewTargetToken, viewRequest(), viewConfig)
    const run = projection.snapshot.nodes.find(node => node.kind === 'run')!
    const plan = projection.snapshot.nodes.find(node => node.kind === 'plan')!
    expect(researchViewDetailSchema.parse(projection.details.get(plan.id))).toEqual(projection.details.get(plan.id))
    expect(researchViewDetailSchema.safeParse(projection.details.get(run.id)).success).toBe(true)
    expect(researchViewDetailSchema.safeParse({ kind: 'run', node: run, record: {} }).success).toBe(true)
    for (const record of [[], null, 'json text', { value: () => 0 }, { value: Infinity }, { value: undefined }]) expect(researchViewDetailSchema.safeParse({ kind: 'run', node: run, record }).success).toBe(false)
    expect(researchViewDetailSchema.safeParse({ kind: 'run', node: { ...run, status: 'running' }, record: {} }).success).toBe(false)
    expect(researchViewDetailSchema.safeParse({ kind: 'run', node: run, record: {}, extra: 1 }).success).toBe(false)
  })

  it('validates rendered wrapper identities and invalidation hints without granting arbitrary spec input', () => {
    const artifact = { html: '<!DOCTYPE html>', svg: '<svg/>', revision: hash, nodeIds: ['plan_1_v1'], specSha256: hash, engineFingerprint: hash }
    expect(researchViewRenderedSchema.parse(artifact)).toEqual(artifact)
    for (const patch of [{ nodeIds: ['../v1.md'] }, { revision: 'bad' }, { engineFingerprint: 'bad' }, { specSha256: null }, { html: null }, { svg: 1 }, { extra: {} }]) expect(researchViewRenderedSchema.safeParse({ ...artifact, ...patch }).success).toBe(false)
    expect(researchViewChangedSchema.safeParse({ targetToken: hash }).success).toBe(true)
    expect(researchViewChangedSchema.safeParse({ targetToken: hash, sessionId: 'extra' }).success).toBe(false)
    const stream = viewInvocations.find(item => item.method === 'watchView')!
    expect(stream).toMatchObject({ mode: 'stream', invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' }, result: { mode: 'strict' } })
    expect(viewInvocations.every(item => item.parameters[0]?.codec.mode === 'strict')).toBe(true)
  })
})
