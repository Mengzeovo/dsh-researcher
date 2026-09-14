import { type RecordStore } from './record-store.ts';
import type { ResearchId } from './types.ts';
import type { ResearchReadContext, ResearchViewConfig, ResearchViewData } from './view-types.ts';
/** Caller holds the same per-target mutex used by research mutations. */
export declare function readResearchViewData(records: RecordStore, context: ResearchReadContext, id: ResearchId, config: ResearchViewConfig, signal?: AbortSignal): Promise<ResearchViewData>;
//# sourceMappingURL=view-data.d.ts.map