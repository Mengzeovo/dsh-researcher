/** Public, lossless-JSON researcher domain types. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { InputCheckpoint, OutputCheckpoint, ReproductionSpec } from './checkpoint.ts';
export type { InputCheckpoint, OutputCheckpoint, ReproductionSpec } from './checkpoint.ts';
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
export type ResearchStatus = 'active' | 'paused' | 'blocked' | 'complete';
export interface ResearchGoalDocument {
    readonly markdown: string;
    readonly goal: string;
    readonly metrics: string;
    readonly baseline: string;
    readonly description: string;
}
export interface ResearchState {
    readonly version: 1;
    readonly revision: number;
    readonly at: string;
    readonly sessionId: string;
    readonly status: ResearchStatus;
    readonly summary: string;
    readonly direction?: string | undefined;
    readonly next?: string | undefined;
    readonly lastRunId?: RunId | undefined;
}
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
/** New descriptions freeze input code before execution. Legacy v1 remains readable. */
export interface CheckpointRunDescription extends Omit<LegacyRunDescription, 'version'> {
    readonly version: 2;
    readonly baseStateRevision: number;
    readonly checkpoint: InputCheckpoint;
}
export type ResearchRunDescription = LegacyRunDescription | CheckpointRunDescription;
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
export type ResearchRunResult = LegacyRunResult | CheckpointRunResult;
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
}
export interface ResearchTargetSnapshot {
    readonly id: ResearchId;
    readonly root: string;
    readonly goalPath: string;
    readonly goal: ResearchGoalDocument;
    readonly state: ResearchState;
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
export interface ResearchLoadResult {
    readonly researchId: ResearchId;
    readonly eventSeq: number;
    readonly target: ResearchTargetSnapshot;
    readonly context: ResearchContextSnapshot;
    readonly goalAction: 'created' | 'updated' | 'resumed' | 'completed' | 'unchanged' | 'view-only' | 'recovery-only';
}
export interface ResearchCreateResult extends ResearchLoadResult {
    readonly created: true;
}
export interface ResearchStateResult {
    readonly researchId: ResearchId;
    readonly state: ResearchState;
    readonly path: string;
}
export interface ResearchRunStartResult {
    readonly researchId: ResearchId;
    readonly runId: RunId;
    readonly path: string;
    readonly checkpoint: InputCheckpoint;
}
export interface ResearchRunFinishResult {
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