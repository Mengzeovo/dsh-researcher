/** Browser-safe JSON validation for research view requests and responses. */
import { z } from 'zod';
import type { ResearchViewChanged, ResearchViewNodeDetail, ResearchViewNodeRequest, ResearchViewRenderRequest, ResearchViewRendered, ResearchViewRequest, ResearchViewResponse } from './view-types.ts';
export declare const researchViewRequestSchema: z.ZodType<ResearchViewRequest>;
export declare const researchViewWatchRequestSchema: z.ZodObject<{
    sessionId: z.ZodString;
}, z.core.$strict>;
export declare const researchViewNodeRequestSchema: z.ZodType<ResearchViewNodeRequest>;
export declare const researchViewRenderRequestSchema: z.ZodType<ResearchViewRenderRequest>;
export declare const researchViewResponseSchema: z.ZodType<ResearchViewResponse>;
export declare const researchViewDetailSchema: z.ZodType<ResearchViewNodeDetail>;
export declare const researchViewRenderedSchema: z.ZodType<ResearchViewRendered>;
export declare const researchViewChangedSchema: z.ZodType<ResearchViewChanged>;
//# sourceMappingURL=view-wire.d.ts.map