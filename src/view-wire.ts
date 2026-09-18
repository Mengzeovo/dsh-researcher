/** Browser-safe JSON validation for research view requests and responses. */
import { z } from 'zod'
import { planMetadataSchema, planVersionRefSchema } from './plan-schema.ts'
import { researchIdSchema, researchStatusSchema, UUID_PATTERN } from './wire.ts'
import type { RunId } from './types.ts'
import type { ResearchViewArtifactId, ResearchViewChanged, ResearchViewNodeDetail, ResearchViewNodeId, ResearchViewNodeRequest, ResearchViewRenderRequest, ResearchViewRendered, ResearchViewRequest, ResearchViewResponse, ResearchViewSnapshotId, ResearchViewTargetToken } from './view-types.ts'

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const page = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[0-9a-f]{64}$/u)
const runId = z.string().regex(UUID_PATTERN).transform(value => value as RunId)
const snapshotId = hash.transform(value => value as ResearchViewSnapshotId)
const targetToken = hash.transform(value => value as ResearchViewTargetToken)
const artifactId = hash.transform(value => value as ResearchViewArtifactId)
const nodeId = z.string().refine(value => /^plan_[1-9][0-9]*_v[1-9][0-9]*$/u.test(value) || (value.startsWith('run_') && UUID_PATTERN.test(value.slice(4))), 'invalid research node id').transform(value => value as ResearchViewNodeId)
const sessionId = z.string().min(1).refine(value => value.trim().length > 0)
const runPages = z.record(z.string().regex(/^[1-9][0-9]*$/u), page)
const jsonRecord = z.record(z.string(), z.json())
const selection = z.object({ planId: positive.nullable(), runPages }).strict()
const goal = z.object({ markdown: z.string(), goal: z.string(), metrics: z.string(), baseline: z.string(), description: z.string() }).strict()
const stateFields = { revision: positive, at: z.string(), sessionId, status: researchStatusSchema, summary: z.string(), direction: z.string().optional(), next: z.string().optional(), lastRunId: runId.optional() }
const state = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...stateFields }).strict(),
  z.object({ version: z.literal(2), ...stateFields, selectedPlanRef: planVersionRefSchema.optional() }).strict(),
])
const baseNode = { id: nodeId, planId: positive, revision: positive, title: z.string(), summary: z.string(), path: z.string(), createdAt: z.string(), column: page, slot: page.max(3) }
const planNode = z.object({ ...baseNode, kind: z.literal('plan'), selected: z.boolean(), sha256: hash }).strict()
const runNode = z.object({ ...baseNode, kind: z.literal('run'), runId, status: z.enum(['unsealed', 'completed', 'failed']), pendingState: z.boolean(), metrics: jsonRecord }).strict()
const edge = z.object({ id: z.string().min(1), kind: z.enum(['uses-plan', 'informs-plan', 'revises-plan']), from: nodeId, to: nodeId, label: z.string() }).strict()
const diagnostic = z.object({ code: z.string(), message: z.string(), path: z.string().optional(), planId: positive.optional(), nodeId: nodeId.optional() }).strict()

// Old clients may send a revision-page selection; validate then discard it.
// It never affects graph membership or snapshot/cache identity.
export const researchViewRequestSchema: z.ZodType<ResearchViewRequest> = z.object({ sessionId, planId: positive.optional(), versionPage: page.optional(), runPages: runPages.optional(), ifNoneMatch: snapshotId.optional(), refresh: z.boolean().optional() }).strict().transform(({ versionPage: _obsolete, ...request }) => request)
export const researchViewWatchRequestSchema = z.object({ sessionId }).strict()
export const researchViewNodeRequestSchema: z.ZodType<ResearchViewNodeRequest> = z.object({ sessionId, snapshotId, nodeId }).strict()
export const researchViewRenderRequestSchema: z.ZodType<ResearchViewRenderRequest> = z.object({ sessionId, snapshotId, theme: z.enum(['light', 'dark']), locale: z.enum(['en', 'zh-CN']) }).strict()
export const researchViewResponseSchema: z.ZodType<ResearchViewResponse> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unbound') }).strict(),
  z.object({ kind: z.literal('unchanged'), snapshotId }).strict(),
  z.object({
    kind: z.enum(['ready', 'empty']), snapshotId, targetToken, researchId: researchIdSchema, goal, state,
    groups: z.array(z.object({ planId: positive, title: z.string(), latestRevision: page, revisionCount: page, runCount: page, warningCount: page }).strict()),
    selection, pages: z.object({ runsPerVersionPage: positive.max(4), runCounts: z.record(z.string(), page) }).strict(),
    nodes: z.array(z.discriminatedUnion('kind', [planNode, runNode])), edges: z.array(edge),
    outsideLinks: z.array(z.object({ edge, nodeId, selection }).strict()), diagnostics: z.array(diagnostic),
  }).strict(),
])
export const researchViewDetailSchema: z.ZodType<ResearchViewNodeDetail> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan'), node: planNode, document: z.object({ metadata: planMetadataSchema, body: z.string(), markdown: z.string(), sha256: hash }).strict() }).strict(),
  z.object({ kind: z.literal('run'), node: runNode, record: jsonRecord }).strict(),
])
export const researchViewRenderedSchema: z.ZodType<ResearchViewRendered> = z.object({ html: z.string(), svg: z.string(), revision: artifactId, nodeIds: z.array(nodeId), specSha256: hash, engineFingerprint: hash }).strict()
export const researchViewChangedSchema: z.ZodType<ResearchViewChanged> = z.object({ targetToken }).strict()
