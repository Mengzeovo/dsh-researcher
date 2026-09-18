import { z } from 'zod';
import type { PreparedPlanRunResult, PreparedResearchRunResult, ResearchBinding, ResearchGlossary, ResearchGoalDocument, ResearchId, ResearchRunDescription, ResearchRunResult, ResearchSessionIndex, ResearchState, RunId } from './types.ts';
export { invalidResearchTargetSummarySchema, researchIdSchema, researchStatusSchema, researchTargetListRequestSchema, researchTargetListSchema, researchTargetSummarySchema, } from './wire.ts';
export declare const RECORD_MAX_BYTES: number;
export declare const SESSION_INDEX_MAX_BYTES: number;
export declare const CONTEXT_MAX_CHARS: number;
export declare const POPUP_LABEL_MAX_CHARS = 120;
export declare const SESSION_FILENAME_MAX_CHARS = 240;
export declare const runIdSchema: z.ZodPipe<z.ZodString, z.ZodTransform<RunId, string>>;
export declare const researchStateV1Schema: z.ZodObject<{
    revision: z.ZodNumber;
    at: z.ZodString;
    sessionId: z.ZodString;
    status: z.ZodEnum<{
        active: "active";
        paused: "paused";
        blocked: "blocked";
        complete: "complete";
    }>;
    summary: z.ZodString;
    direction: z.ZodOptional<z.ZodString>;
    next: z.ZodOptional<z.ZodString>;
    lastRunId: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<RunId, string>>>;
    version: z.ZodLiteral<1>;
}, z.core.$strict>;
export declare const researchStateV2Schema: z.ZodObject<{
    selectedPlanRef: z.ZodOptional<z.ZodType<import("./plan-schema.ts").PlanVersionRef, unknown, z.core.$ZodTypeInternals<import("./plan-schema.ts").PlanVersionRef, unknown>>>;
    revision: z.ZodNumber;
    at: z.ZodString;
    sessionId: z.ZodString;
    status: z.ZodEnum<{
        active: "active";
        paused: "paused";
        blocked: "blocked";
        complete: "complete";
    }>;
    summary: z.ZodString;
    direction: z.ZodOptional<z.ZodString>;
    next: z.ZodOptional<z.ZodString>;
    lastRunId: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<RunId, string>>>;
    version: z.ZodLiteral<2>;
}, z.core.$strict>;
/** Reading legacy snapshots never manufactures a selection or changes their version. */
export declare const researchStateSchema: z.ZodType<ResearchState>;
export declare const researchGlossarySchema: z.ZodType<ResearchGlossary>;
export declare const reproductionSchema: z.ZodObject<{
    command: z.ZodString;
    cwd: z.ZodUnion<readonly [z.ZodLiteral<".">, z.ZodString]>;
    environment: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    inputs: z.ZodArray<z.ZodString>;
    snapshot: z.ZodOptional<z.ZodObject<{
        mode: z.ZodLiteral<"scoped">;
        paths: z.ZodArray<z.ZodString>;
        omitChanges: z.ZodOptional<z.ZodArray<z.ZodString>>;
        externalInputs: z.ZodOptional<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            sha256: z.ZodString;
            bytes: z.ZodNumber;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const inputCheckpointSchema: z.ZodObject<{
    backend: z.ZodLiteral<"git">;
    inputRef: z.ZodString;
    outputRef: z.ZodString;
    inputCommit: z.ZodString;
    inputTree: z.ZodString;
    baseHead: z.ZodString;
    objectFormat: z.ZodEnum<{
        sha256: "sha256";
        sha1: "sha1";
    }>;
    files: z.ZodArray<z.ZodString>;
    reproduction: z.ZodObject<{
        command: z.ZodString;
        cwd: z.ZodUnion<readonly [z.ZodLiteral<".">, z.ZodString]>;
        environment: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
        inputs: z.ZodArray<z.ZodString>;
        snapshot: z.ZodOptional<z.ZodObject<{
            mode: z.ZodLiteral<"scoped">;
            paths: z.ZodArray<z.ZodString>;
            omitChanges: z.ZodOptional<z.ZodArray<z.ZodString>>;
            externalInputs: z.ZodOptional<z.ZodArray<z.ZodObject<{
                path: z.ZodString;
                sha256: z.ZodString;
                bytes: z.ZodNumber;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    snapshot: z.ZodOptional<z.ZodObject<{
        mode: z.ZodLiteral<"scoped-overlay">;
        deleted: z.ZodArray<z.ZodString>;
        omittedChanges: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const outputCheckpointSchema: z.ZodObject<{
    backend: z.ZodLiteral<"git">;
    inputRef: z.ZodString;
    outputRef: z.ZodString;
    inputCommit: z.ZodString;
    outputCommit: z.ZodString;
    inputTree: z.ZodString;
    outputTree: z.ZodString;
    objectFormat: z.ZodEnum<{
        sha256: "sha256";
        sha1: "sha1";
    }>;
    codeChanged: z.ZodBoolean;
    snapshot: z.ZodOptional<z.ZodObject<{
        mode: z.ZodLiteral<"scoped-overlay">;
        baseHead: z.ZodString;
        deleted: z.ZodArray<z.ZodString>;
    }, z.core.$strict>>;
    artifacts: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        sha256: z.ZodString;
        bytes: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const researchRunDescriptionSchema: z.ZodType<ResearchRunDescription>;
/** A journal payload has no checkpoint: its output commit does not exist yet. */
export declare const preparedPlanRunResultSchema: z.ZodType<PreparedPlanRunResult>;
export declare const researchPreparedRunResultSchema: z.ZodType<PreparedResearchRunResult>;
export declare const researchRunResultSchema: z.ZodType<ResearchRunResult>;
export declare const researchSessionIndexSchema: z.ZodType<ResearchSessionIndex>;
export declare const researchBindingSchema: z.ZodType<ResearchBinding>;
export declare function parseResearchId(value: string): ResearchId;
export declare function parseRunId(value: string): RunId;
export declare function parseGoalMarkdown(markdown: string): ResearchGoalDocument;
export declare function renderGoalMarkdown(goal: string, metrics: readonly string[], baseline: string): string;
export declare function firstParagraph(value: string): string;
export declare function truncateLabel(value: string): string;
export declare function normalizeProjectRelativePath(value: string): string;
export declare function encodeSessionId(sessionId: string): string;
export declare function decodeSessionId(encoded: string): string;
export declare function assertUtf8Bound(subject: string, value: string, maxBytes: number): void;
export declare function parseJsonText<T>(subject: string, text: string, schema: z.ZodType<T>, maxBytes: number): T;
export declare function stableJsonLine(value: unknown): string;
export declare function requireNonBlank(subject: string, value: string): string;
export declare function nowIso(): string;
//# sourceMappingURL=schema.d.ts.map