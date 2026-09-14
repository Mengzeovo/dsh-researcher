/** Browser-safe strict schemas for the Root researcher Remote methods. */
import { z } from 'zod';
import type { InvalidResearchTargetSummary, ResearchId, ResearchViewClientConfig, ResearchTargetList, ResearchTargetListRequest, ResearchTargetSummary } from './types.ts';
/** Reject extra fields rather than forwarding arbitrary Host configuration. */
export declare const researchViewClientConfigSchema: z.ZodType<ResearchViewClientConfig>;
export declare const UUID_PATTERN: RegExp;
export declare const researchIdSchema: z.ZodPipe<z.ZodString, z.ZodTransform<ResearchId, string>>;
export declare const researchStatusSchema: z.ZodEnum<{
    active: "active";
    paused: "paused";
    blocked: "blocked";
    complete: "complete";
}>;
export declare const researchTargetListRequestSchema: z.ZodType<ResearchTargetListRequest>;
export declare const researchTargetSummarySchema: z.ZodType<ResearchTargetSummary>;
export declare const invalidResearchTargetSummarySchema: z.ZodType<InvalidResearchTargetSummary>;
export declare const researchTargetListSchema: z.ZodType<ResearchTargetList>;
//# sourceMappingURL=wire.d.ts.map