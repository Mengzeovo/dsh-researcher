/** Deployment choices for the optional native-plugin research view. */
import { z } from 'zod';
import type { ResearchViewConfig } from './view-types.ts';
export declare const researchViewConfigSchema: z.ZodType<ResearchViewConfig>;
export interface ResearcherConfig {
    readonly view: ResearchViewConfig;
}
export declare const researcherConfigSchema: z.ZodObject<{
    view: z.ZodDefault<z.ZodType<ResearchViewConfig, unknown, z.core.$ZodTypeInternals<ResearchViewConfig, unknown>>>;
}, z.core.$strict>;
/** Resolve optional Loader configuration before creating services. */
export declare function resolveResearcherConfig(input: unknown): ResearcherConfig;
//# sourceMappingURL=view-config.d.ts.map