/** Browser-safe strict schemas for the single researcher Remote surface. */
import { z } from 'zod';
import type { InvalidResearchTargetSummary, ResearchId, ResearchTargetList, ResearchTargetListRequest, ResearchTargetSummary } from './types.ts';
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