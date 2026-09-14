import { z } from 'zod';
import type { RunId } from './types.ts';
/** Shared plan identity stays independent of research/run record schema versions. */
export interface PlanVersionRef {
    readonly planId: number;
    readonly revision: number;
    readonly sha256: string;
}
/** A caller-authored explanation of a sealed experiment that informed this revision. */
export interface PlanRunBasisInput {
    readonly runId: RunId;
    readonly reason: string;
}
/** The Host pins the exact sealed Run bytes, not a model-supplied digest. */
export interface PlanRunEvidence {
    readonly run_id: RunId;
    readonly reason: string;
    readonly sha256: string;
}
export interface PlanContentInput {
    readonly title: string;
    readonly body: string;
    readonly delta: readonly string[];
    readonly basedOnRuns?: readonly PlanRunBasisInput[] | undefined;
}
export interface PlanMetadataV1 {
    readonly schema_version: 1;
    readonly plan_id: number;
    readonly revision: number;
    readonly title: string;
    readonly created_at: string;
    readonly delta: readonly string[];
}
export interface PlanMetadataV2 extends Omit<PlanMetadataV1, 'schema_version'> {
    readonly schema_version: 2;
    readonly based_on_runs: readonly PlanRunEvidence[];
}
export type PlanMetadata = PlanMetadataV1 | PlanMetadataV2;
export interface PlanDocument {
    readonly metadata: PlanMetadata;
    readonly body: string;
    readonly markdown: string;
    readonly sha256: string;
}
export interface PlanLedgerEntry {
    readonly schema_version: 1;
    readonly plan_id: number;
    readonly revision: number;
    readonly file: string;
    readonly sha256: string;
}
export declare const planNumberSchema: z.ZodNumber;
export declare const planVersionRefSchema: z.ZodType<PlanVersionRef>;
export declare const planRunBasisInputSchema: z.ZodType<PlanRunBasisInput>;
export declare const planRunEvidenceSchema: z.ZodType<PlanRunEvidence>;
export declare const planContentInputSchema: z.ZodType<PlanContentInput>;
export declare const planMetadataSchema: z.ZodType<PlanMetadata>;
export declare const planDocumentSchema: z.ZodType<PlanDocument>;
export declare const planLedgerEntrySchema: z.ZodType<PlanLedgerEntry>;
//# sourceMappingURL=plan-schema.d.ts.map