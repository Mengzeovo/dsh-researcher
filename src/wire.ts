/** Browser-safe strict schemas for the Root researcher Remote methods. */

import { z } from 'zod'
import type {
  InvalidResearchTargetSummary,
  ResearchId,
  ResearchViewClientConfig,
  ResearchTargetList,
  ResearchTargetListRequest,
  ResearchTargetSummary,
} from './types.ts'

/** Reject extra fields rather than forwarding arbitrary Host configuration. */
export const researchViewClientConfigSchema: z.ZodType<ResearchViewClientConfig> = z.object({
  enabled: z.boolean(),
  presetIds: z.array(z.string().min(1)).min(1),
}).strict()

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const nonBlank = z.string().refine(value => value.trim().length > 0, 'must contain a non-whitespace character')
const isoUtc = z.string().refine(value => {
  const parsed = new Date(value)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value
}, 'must be an ISO-8601 UTC timestamp produced by Date.toISOString()')

export const researchIdSchema = z.string().regex(UUID_PATTERN).transform(value => value as ResearchId)
export const researchStatusSchema = z.enum(['active', 'paused', 'blocked', 'complete'])

export const researchTargetListRequestSchema: z.ZodType<ResearchTargetListRequest> = z.object({
  sessionId: nonBlank,
}).strict()

export const researchTargetSummarySchema: z.ZodType<ResearchTargetSummary> = z.object({
  id: researchIdSchema,
  description: nonBlank,
  status: researchStatusSchema,
  updatedAt: isoUtc,
  warningCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

export const invalidResearchTargetSummarySchema: z.ZodType<InvalidResearchTargetSummary> = z.object({
  id: researchIdSchema,
  code: nonBlank,
  detail: nonBlank,
}).strict()

export const researchTargetListSchema: z.ZodType<ResearchTargetList> = z.object({
  version: z.literal(1),
  boundResearchId: researchIdSchema.optional(),
  targets: z.array(researchTargetSummarySchema),
  invalid: z.array(invalidResearchTargetSummarySchema),
}).strict()
