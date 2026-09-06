import { z } from 'zod';
import type { ResearchBinding, ResearchGlossary, ResearchGoalDocument, ResearchId, ResearchRunDescription, ResearchRunResult, ResearchSessionIndex, ResearchState, RunId } from './types.ts';
export { invalidResearchTargetSummarySchema, researchIdSchema, researchStatusSchema, researchTargetListRequestSchema, researchTargetListSchema, researchTargetSummarySchema, } from './wire.ts';
export declare const RECORD_MAX_BYTES: number;
export declare const SESSION_INDEX_MAX_BYTES: number;
export declare const CONTEXT_MAX_CHARS: number;
export declare const POPUP_LABEL_MAX_CHARS = 120;
export declare const SESSION_FILENAME_MAX_CHARS = 240;
export declare const runIdSchema: z.ZodPipe<z.ZodString, z.ZodTransform<RunId, string>>;
export declare const researchStateSchema: z.ZodType<ResearchState>;
export declare const researchGlossarySchema: z.ZodType<ResearchGlossary>;
export declare const reproductionSchema: z.ZodObject<{
    command: z.ZodString;
    cwd: z.ZodUnion<readonly [z.ZodLiteral<".">, z.ZodString]>;
    environment: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    inputs: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export declare const inputCheckpointSchema: z.ZodObject<{
    backend: z.ZodLiteral<"git">;
    inputRef: z.ZodString;
    outputRef: z.ZodString;
    inputCommit: z.ZodString;
    inputTree: z.ZodString;
    baseHead: z.ZodString;
    objectFormat: z.ZodEnum<{
        sha1: "sha1";
        sha256: "sha256";
    }>;
    files: z.ZodArray<z.ZodString>;
    reproduction: z.ZodObject<{
        command: z.ZodString;
        cwd: z.ZodUnion<readonly [z.ZodLiteral<".">, z.ZodString]>;
        environment: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
        inputs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
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
        sha1: "sha1";
        sha256: "sha256";
    }>;
    codeChanged: z.ZodBoolean;
    artifacts: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        sha256: z.ZodString;
        bytes: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const researchRunDescriptionSchema: z.ZodType<ResearchRunDescription>;
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