/** Research view values are read-only projections, never authority records. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { PlanDocument } from './plan-schema.ts'
import type { ResearchGoalDocument, ResearchId, ResearchRun, ResearchState, RunId } from './types.ts'

export type ResearchViewNodeId = Branded<'ResearchViewNodeId'>
export type ResearchViewSnapshotId = Branded<'ResearchViewSnapshotId'>
export type ResearchViewTargetToken = Branded<'ResearchViewTargetToken'>
export type ResearchViewArtifactId = Branded<'ResearchViewArtifactId'>

export interface ResearchViewConfig {
  readonly enabled: boolean
  readonly presetIds: readonly string[]
  readonly versionsPerPage: number
  readonly runsPerVersionPage: number
  readonly maxRecords: number
  readonly maxDataBytes: number
  readonly maxSnapshotBytes: number
  readonly maxDetailBytes: number
  readonly maxRenderBytes: number
  readonly cacheEntries: number
}
export interface ResearchReadContext { readonly workspaceRoot: string }
export interface ResearchViewDiagnostic {
  readonly code: string
  readonly message: string
  readonly path?: string | undefined
  readonly planId?: number | undefined
  readonly nodeId?: ResearchViewNodeId | undefined
}
export interface ResearchViewPlanRecord { readonly document: PlanDocument; readonly path: string }
export interface ResearchViewRunRecord { readonly run: ResearchRun; readonly path: string; readonly sha256: string; readonly committed: boolean }
export interface ResearchViewData {
  readonly researchId: ResearchId
  readonly goal: ResearchGoalDocument
  readonly state: ResearchState
  readonly planDirectories: readonly number[]
  readonly plans: readonly ResearchViewPlanRecord[]
  readonly runs: readonly ResearchViewRunRecord[]
  readonly diagnostics: readonly ResearchViewDiagnostic[]
  readonly recordVersion: string
}
export interface ResearchViewPlanGroup {
  readonly planId: number
  readonly title: string
  readonly latestRevision: number
  readonly revisionCount: number
  readonly runCount: number
  readonly warningCount: number
}
export interface ResearchViewSelection {
  readonly planId: number | null
  readonly versionPage: number
  readonly runPages: Readonly<Record<string, number>>
}
export interface ResearchViewPageInfo {
  readonly versionPages: number
  readonly versionsPerPage: number
  readonly runsPerVersionPage: number
  readonly runCounts: Readonly<Record<string, number>>
}
interface ResearchViewNodeBase {
  readonly id: ResearchViewNodeId
  readonly planId: number
  readonly revision: number
  readonly title: string
  readonly summary: string
  readonly path: string
  readonly createdAt: string
  readonly column: number
  readonly slot: number
}
export interface ResearchPlanViewNode extends ResearchViewNodeBase {
  readonly kind: 'plan'
  readonly selected: boolean
  readonly sha256: string
}
export interface ResearchRunViewNode extends ResearchViewNodeBase {
  readonly kind: 'run'
  readonly runId: RunId
  readonly status: 'unsealed' | 'completed' | 'failed'
  readonly pendingState: boolean
  readonly metrics: Readonly<Record<string, JsonValue>>
}
export type ResearchViewNode = ResearchPlanViewNode | ResearchRunViewNode
export interface ResearchViewEdge {
  readonly id: string
  readonly kind: 'uses-plan' | 'informs-plan' | 'revises-plan'
  readonly from: ResearchViewNodeId
  readonly to: ResearchViewNodeId
  readonly label: string
}
export interface ResearchViewOutsideLink {
  readonly edge: ResearchViewEdge
  readonly nodeId: ResearchViewNodeId
  readonly selection: ResearchViewSelection
}
export interface ResearchViewSnapshot {
  readonly kind: 'ready' | 'empty'
  readonly snapshotId: ResearchViewSnapshotId
  readonly targetToken: ResearchViewTargetToken
  readonly researchId: ResearchId
  readonly goal: ResearchGoalDocument
  readonly state: ResearchState
  readonly groups: readonly ResearchViewPlanGroup[]
  readonly selection: ResearchViewSelection
  readonly pages: ResearchViewPageInfo
  readonly nodes: readonly ResearchViewNode[]
  readonly edges: readonly ResearchViewEdge[]
  readonly outsideLinks: readonly ResearchViewOutsideLink[]
  readonly diagnostics: readonly ResearchViewDiagnostic[]
}
export interface ResearchViewRequest {
  readonly sessionId: string
  readonly planId?: number | undefined
  readonly versionPage?: number | undefined
  readonly runPages?: Readonly<Record<string, number>> | undefined
  readonly ifNoneMatch?: ResearchViewSnapshotId | undefined
  readonly refresh?: boolean | undefined
}
export type ResearchViewResponse = ResearchViewSnapshot | { readonly kind: 'unbound' } | { readonly kind: 'unchanged'; readonly snapshotId: ResearchViewSnapshotId }
export interface ResearchViewWatchRequest { readonly sessionId: string }
export interface ResearchViewNodeRequest { readonly sessionId: string; readonly snapshotId: ResearchViewSnapshotId; readonly nodeId: ResearchViewNodeId }
export type ResearchViewNodeDetail =
  | { readonly kind: 'plan'; readonly node: ResearchPlanViewNode; readonly document: PlanDocument }
  | { readonly kind: 'run'; readonly node: ResearchRunViewNode; readonly record: Readonly<Record<string, JsonValue>> }
export interface ResearchViewRenderRequest {
  readonly sessionId: string
  readonly snapshotId: ResearchViewSnapshotId
  readonly theme: 'light' | 'dark'
  readonly locale: 'en' | 'zh-CN'
}
export interface ResearchViewRendered {
  readonly html: string
  readonly svg: string
  readonly revision: ResearchViewArtifactId
  readonly nodeIds: readonly string[]
  readonly specSha256: string
  readonly engineFingerprint: string
}
export interface ResearchViewChanged { readonly targetToken: ResearchViewTargetToken }
