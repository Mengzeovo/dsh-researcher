import type { ResearchViewConfig, ResearchViewData, ResearchViewNodeDetail, ResearchViewNodeId, ResearchViewRequest, ResearchViewSnapshot, ResearchViewTargetToken } from './view-types.ts';
export declare function planNodeId(planId: number, revision: number): ResearchViewNodeId;
export declare function runNodeId(runId: string): ResearchViewNodeId;
/** Summaries preserve authored content; they are not model-generated paraphrases. */
export declare function viewExcerpt(value: string, length: number): string;
export interface ResearchViewProjection {
    readonly snapshot: ResearchViewSnapshot;
    readonly details: ReadonlyMap<ResearchViewNodeId, ResearchViewNodeDetail>;
}
/** Input records already passed file/schema checks; this function verifies their cross-references. */
export declare function projectResearchView(data: ResearchViewData, targetToken: ResearchViewTargetToken, request: ResearchViewRequest, config: ResearchViewConfig): ResearchViewProjection;
//# sourceMappingURL=view-projection.d.ts.map