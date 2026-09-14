/** Public, lossless-JSON researcher domain types. */
export type * from './view-types.ts';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { InputCheckpoint, OutputCheckpoint, ReproductionSpec } from './checkpoint.ts';
import type { PlanContentInput, PlanDocument, PlanVersionRef } from './plan-schema.ts';
export type { InputCheckpoint, OutputCheckpoint, ReproductionSpec } from './checkpoint.ts';
export type { PlanContentInput, PlanDocument, PlanVersionRef } from './plan-schema.ts';
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface RemoteErrorDetailsMap {
        'researcher/domain': {
            readonly code: string;
        };
    }
}
declare const researchIdBrand: unique symbol;
declare const runIdBrand: unique symbol;
export type ResearchId = string & {
    readonly [researchIdBrand]: true;
};
export type RunId = string & {
    readonly [runIdBrand]: true;
};
/** Public Host-authoritative UI settings; no other Host configuration is exposed. */
export interface ResearchViewClientConfig {
    readonly enabled: boolean;
    readonly presetIds: readonly string[];
}
export type ResearchStatus = 'active' | 'paused' | 'blocked' | 'complete';
export interface ResearchGoalDocument {
    readonly markdown: string;
    readonly goal: string;
    readonly metrics: string;
    readonly baseline: string;
    readonly description: string;
}
export interface ResearchStateV1 {
    readonly version: 1;
    /** Legacy records have no selection; their schema does not permit this field. */
    readonly selectedPlanRef?: undefined;
    readonly revision: number;
    readonly at: string;
    readonly sessionId: string;
    readonly status: ResearchStatus;
    readonly summary: string;
    readonly direction?: string | undefined;
    readonly next?: string | undefined;
    readonly lastRunId?: RunId | undefined;
}
export interface ResearchStateV2 extends Omit<ResearchStateV1, 'version' | 'selectedPlanRef'> {
    readonly version: 2;
    readonly selectedPlanRef?: PlanVersionRef | undefined;
}
export type ResearchState = ResearchStateV1 | ResearchStateV2;
export interface ResearchGlossary {
    readonly version: 1;
    readonly terms: Readonly<Record<string, string>>;
    readonly files: Readonly<Record<string, string>>;
}
export interface LegacyRunDescription {
    readonly version: 1;
    readonly type: 'description';
    readonly createdAt: string;
    readonly sessionId: string;
    readonly purpose: string;
    readonly parameters: Readonly<Record<string, JsonValue>>;
}
/** Pre-plan descriptions freeze input code; legacy v1/v2 remain readable. */
export interface CheckpointRunDescription extends Omit<LegacyRunDescription, 'version'> {
    readonly version: 2;
    readonly baseStateRevision: number;
    readonly checkpoint: InputCheckpoint;
}
export interface PlanRunDescription extends Omit<CheckpointRunDescription, 'version'> {
    readonly version: 3;
    readonly planRef: PlanVersionRef;
}
export type ResearchRunDescription = LegacyRunDescription | CheckpointRunDescription | PlanRunDescription;
export declare function isCheckpointRunDescription(value: ResearchRunDescription): value is CheckpointRunDescription | PlanRunDescription;
export declare function samePlanVersionRef(left: PlanVersionRef | undefined, right: PlanVersionRef | undefined): boolean;
export interface LegacyRunResult {
    readonly version: 1;
    readonly type: 'result';
    readonly finishedAt: string;
    readonly status: 'completed' | 'failed';
    readonly result: string;
    readonly metrics: Readonly<Record<string, JsonValue>>;
    readonly decision: string;
    readonly artifacts: readonly string[];
    /** Exact state transition prepared before the immutable result is published. */
    readonly transition: ResearchState;
}
export interface CheckpointRunResult extends Omit<LegacyRunResult, 'version'> {
    readonly version: 2;
    readonly checkpoint: OutputCheckpoint;
}
export interface PlanRunResult extends Omit<CheckpointRunResult, 'version' | 'transition'> {
    readonly version: 3;
    readonly planRef: PlanVersionRef;
    readonly transition: ResearchStateV2 & {
        readonly selectedPlanRef: PlanVersionRef;
    };
}
/** Journal payloads cannot contain the output checkpoint, whose commit is not known yet. */
export type PreparedPlanRunResult = Omit<PlanRunResult, 'checkpoint'>;
export type PreparedResearchRunResult = LegacyRunResult | PreparedPlanRunResult;
export type ResearchRunResult = LegacyRunResult | CheckpointRunResult | PlanRunResult;
export declare function isCheckpointRunResult(value: ResearchRunResult): value is CheckpointRunResult | PlanRunResult;
export interface ResearchRun {
    readonly id: RunId;
    readonly description: ResearchRunDescription;
    readonly result?: ResearchRunResult;
}
export interface ResearchSessionIndex {
    readonly version: 1;
    readonly sessionId: string;
    readonly loadedAt: string;
    readonly runIds: readonly RunId[];
}
export interface ResearchBinding {
    readonly version: 1;
    readonly researchId: ResearchId;
    readonly sessionId: string;
    readonly loadedAt: string;
}
/** Derived from run records; never persisted into research state or session binding. */
export interface ResearchRecovery {
    readonly runId: RunId;
    readonly phase: 'open' | 'pending-state';
    readonly path: string;
    /** Planned ref only: its presence here does not prove that an output was sealed. */
    readonly outputRef?: string;
    readonly planRef?: PlanVersionRef;
}
export interface ResearchTargetSnapshot {
    readonly id: ResearchId;
    readonly root: string;
    readonly goalPath: string;
    readonly goal: ResearchGoalDocument;
    readonly state: ResearchState;
    /** Resolved metadata for the exact selection; never a latest-revision alias. */
    readonly selectedPlan?: {
        readonly ref: PlanVersionRef;
        readonly title: string;
        readonly path: string;
    };
    readonly glossary: ResearchGlossary;
    readonly latestRun?: ResearchRun;
    readonly recovery?: ResearchRecovery | undefined;
    readonly warnings: readonly string[];
}
export interface ResearchTargetSummary {
    readonly id: ResearchId;
    readonly description: string;
    readonly status: ResearchStatus;
    readonly updatedAt: string;
    readonly warningCount: number;
}
export interface InvalidResearchTargetSummary {
    readonly id: ResearchId;
    readonly code: string;
    readonly detail: string;
}
export interface ResearchTargetListRequest {
    readonly sessionId: string;
}
export interface ResearchTargetList {
    readonly version: 1;
    readonly boundResearchId?: ResearchId | undefined;
    readonly targets: readonly ResearchTargetSummary[];
    readonly invalid: readonly InvalidResearchTargetSummary[];
}
export interface CreateResearchRequest {
    readonly goal: string;
    readonly metrics: readonly string[];
    readonly baseline: string;
    readonly direction?: string;
    readonly next?: string;
}
export interface UpdateResearchRequest {
    readonly status: ResearchStatus;
    readonly summary: string;
    readonly direction?: string | undefined;
    readonly next?: string | undefined;
    readonly lastRunId?: RunId | undefined;
}
export interface StartResearchRunRequest {
    readonly plan: {
        readonly planId: number;
        readonly revision: number;
    };
    readonly purpose: string;
    readonly parameters: Readonly<Record<string, JsonValue>>;
    readonly reproduction: ReproductionSpec;
}
export interface FinishResearchRunRequest {
    readonly runId: RunId;
    readonly status: 'completed' | 'failed';
    readonly result: string;
    readonly metrics: Readonly<Record<string, JsonValue>>;
    readonly decision: string;
    readonly artifacts: readonly string[];
    readonly researchStatus: ResearchStatus;
    readonly summary: string;
    readonly direction?: string;
    readonly next?: string;
}
export type CreateResearchPlanRequest = PlanContentInput;
export interface UpdateResearchPlanRequest extends PlanContentInput {
    readonly planId: number;
    readonly expectedRevision: number;
}
export interface GetResearchPlanRequest {
    readonly planId: number;
    readonly revision?: number;
}
export interface ListResearchPlansRequest {
    readonly afterId?: number;
    readonly limit?: number;
}
export interface SelectResearchPlanRequest {
    readonly planId: number;
    readonly revision: number;
    readonly expectedStateRevision: number;
}
export interface ResearchPlanReadResult {
    readonly researchId: ResearchId;
    readonly plan: PlanDocument;
    readonly path: string;
    readonly latestRevision: number;
    readonly warnings: readonly string[];
}
export interface ResearchPlanSummary {
    readonly planId: number;
    readonly latestRevision: number;
    readonly title: string;
    readonly createdAt: string;
    readonly sha256: string;
    readonly path: string;
}
export interface ResearchPlanListResult {
    readonly researchId: ResearchId;
    readonly plans: readonly ResearchPlanSummary[];
    readonly invalid: readonly {
        readonly planId: number;
        readonly code: string;
        readonly detail: string;
    }[];
    readonly nextAfterId?: number;
}
export interface ResearchGlossaryPatch {
    readonly terms?: Readonly<Record<string, string | null>>;
    readonly files?: Readonly<Record<string, string | null>>;
}
export interface ResearchContextSnapshot {
    readonly text: string;
    readonly sections: readonly {
        readonly name: string;
        readonly text: string;
    }[];
}
export interface ResearchReadResult {
    readonly researchId: ResearchId;
    readonly target: ResearchTargetSnapshot;
    readonly context: ResearchContextSnapshot;
}
interface ResearchContextResult {
    readonly researchId: ResearchId;
    readonly eventSeq: number;
    readonly target: ResearchTargetSnapshot;
    readonly context: ResearchContextSnapshot;
}
/** Loading is a context handoff, never authority to resume work. */
export interface ResearchLoadResult extends ResearchContextResult {
    readonly mode: 'context-only' | 'recovery-only';
    readonly goalAction: 'unchanged' | 'disarmed';
    readonly briefing: 'queued';
}
export interface ResearchActivationResult extends ResearchContextResult {
    readonly goalAction: 'created' | 'updated' | 'resumed' | 'completed' | 'unchanged' | 'view-only' | 'recovery-only';
}
export interface ResearchStartResult {
    readonly researchId: ResearchId;
    readonly target: ResearchTargetSnapshot;
    readonly goalAction: ResearchActivationResult['goalAction'];
}
export interface ResearchCreateResult extends ResearchActivationResult {
    readonly created: true;
}
export interface ResearchStateResult {
    readonly researchId: ResearchId;
    readonly state: ResearchState;
    readonly path: string;
}
export interface ResearchRunStartResult {
    readonly planRef: PlanVersionRef;
    readonly researchId: ResearchId;
    readonly runId: RunId;
    readonly path: string;
    readonly checkpoint: InputCheckpoint;
}
export interface ResearchRunFinishResult {
    readonly planRef?: PlanVersionRef;
    readonly researchId: ResearchId;
    readonly runId: RunId;
    readonly runStatus: 'completed' | 'failed';
    readonly checkpoint?: OutputCheckpoint;
    readonly state: ResearchState;
    readonly path: string;
}
export interface ResearchGlossaryResult {
    readonly researchId: ResearchId;
    readonly path: string;
    readonly termCount: number;
    readonly fileCount: number;
}
//# sourceMappingURL=types.d.ts.map