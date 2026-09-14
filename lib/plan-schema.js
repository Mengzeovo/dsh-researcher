import { z } from 'zod';
import { UUID_PATTERN } from "./wire.js";
const nonBlank = z.string()
    .refine(value => value.trim().length > 0, 'must contain a non-whitespace character')
    .refine(value => value.isWellFormed(), 'must be well-formed Unicode');
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const isoUtc = z.string().refine(value => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}, 'must be an ISO-8601 UTC timestamp produced by Date.toISOString()');
export const planNumberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const delta = z.array(nonBlank).min(1);
export const planVersionRefSchema = z.object({
    planId: planNumberSchema,
    revision: planNumberSchema,
    sha256,
}).strict();
const runId = z.string().regex(UUID_PATTERN).transform(value => value);
const uniqueRunIds = (values) => new Set(values.map(value => value.runId)).size === values.length;
export const planRunBasisInputSchema = z.object({ runId, reason: nonBlank }).strict();
export const planRunEvidenceSchema = z.object({ run_id: runId, reason: nonBlank, sha256 }).strict();
export const planContentInputSchema = z.object({
    title: nonBlank,
    body: nonBlank,
    delta,
    basedOnRuns: z.array(planRunBasisInputSchema).refine(uniqueRunIds, 'experiment references must be unique').optional(),
}).strict();
const metadataFields = {
    plan_id: planNumberSchema,
    revision: planNumberSchema,
    title: nonBlank,
    created_at: isoUtc,
    delta,
};
export const planMetadataSchema = z.discriminatedUnion('schema_version', [
    z.object({ schema_version: z.literal(1), ...metadataFields }).strict(),
    z.object({ schema_version: z.literal(2), ...metadataFields, based_on_runs: z.array(planRunEvidenceSchema) }).strict()
        .refine(value => new Set(value.based_on_runs.map(item => item.run_id)).size === value.based_on_runs.length, 'experiment references must be unique')
        .refine(value => value.revision !== 1 || value.based_on_runs.length === 0, 'initial plans have no experiment basis'),
]);
export const planDocumentSchema = z.object({
    metadata: planMetadataSchema,
    body: nonBlank,
    markdown: nonBlank,
    sha256,
}).strict();
export const planLedgerEntrySchema = z.object({
    schema_version: z.literal(1),
    plan_id: planNumberSchema,
    revision: planNumberSchema,
    file: nonBlank,
    sha256,
}).strict().refine(value => value.file === `v${String(value.revision).padStart(4, '0')}.md`, {
    message: 'file must be the canonical Markdown filename for this revision',
    path: ['file'],
});
//# sourceMappingURL=plan-schema.js.map