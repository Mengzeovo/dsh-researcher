/** Browser-safe strict schemas for the single researcher Remote surface. */
import { z } from 'zod';
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const nonBlank = z.string().refine(value => value.trim().length > 0, 'must contain a non-whitespace character');
const isoUtc = z.string().refine(value => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}, 'must be an ISO-8601 UTC timestamp produced by Date.toISOString()');
export const researchIdSchema = z.string().regex(UUID_PATTERN).transform(value => value);
export const researchStatusSchema = z.enum(['active', 'paused', 'blocked', 'complete']);
export const researchTargetListRequestSchema = z.object({
    sessionId: nonBlank,
}).strict();
export const researchTargetSummarySchema = z.object({
    id: researchIdSchema,
    description: nonBlank,
    status: researchStatusSchema,
    updatedAt: isoUtc,
    warningCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const invalidResearchTargetSummarySchema = z.object({
    id: researchIdSchema,
    code: nonBlank,
    detail: nonBlank,
}).strict();
export const researchTargetListSchema = z.object({
    version: z.literal(1),
    boundResearchId: researchIdSchema.optional(),
    targets: z.array(researchTargetSummarySchema),
    invalid: z.array(invalidResearchTargetSummarySchema),
}).strict();
//# sourceMappingURL=wire.js.map