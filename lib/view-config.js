/** Deployment choices for the optional native-plugin research view. */
import { z } from 'zod';
export const researchViewConfigSchema = z.object({
    enabled: z.boolean().default(false),
    presetIds: z.array(z.string().min(1)).min(1).default(['research']),
    runsPerVersionPage: z.number().int().min(1).max(4).default(4),
    maxRecords: z.number().int().positive().default(6000),
    maxDataBytes: z.number().int().positive().default(32 * 1024 * 1024),
    maxSnapshotBytes: z.number().int().positive().default(1024 * 1024),
    maxDetailBytes: z.number().int().positive().default(512 * 1024),
    maxRenderBytes: z.number().int().positive().default(8 * 1024 * 1024),
    cacheEntries: z.number().int().positive().default(8),
}).strict();
export const researcherConfigSchema = z.object({ view: researchViewConfigSchema.default(() => researchViewConfigSchema.parse({})) }).strict();
/** Resolve optional Loader configuration before creating services. */
export function resolveResearcherConfig(input) { return researcherConfigSchema.parse(input ?? {}); }
//# sourceMappingURL=view-config.js.map