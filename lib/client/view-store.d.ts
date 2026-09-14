import type { ArchifyCamera } from 'dsh-archify-native/types';
import type { ResearchViewNodeId, ResearchViewSelection, ResearchViewTargetToken } from '../view-types.ts';
export interface ResearchViewUiState {
    targetToken: ResearchViewTargetToken | null;
    selection: ResearchViewSelection;
    selectedNodeId: ResearchViewNodeId | null;
    pagesByPlan: Record<string, ResearchViewSelection>;
    cameras: Record<string, ArchifyCamera>;
}
/** Each session-scoped slot instance retains navigation independently of React mounts. */
export declare function createResearchViewStore(): import("@deepseek-ai/dsh-client-store").EngineStoreHandle<ResearchViewUiState, {
    selectPlan: (draft: ResearchViewUiState, planId: number) => void;
    selectPage: (draft: ResearchViewUiState, selection: ResearchViewSelection, nodeId?: ResearchViewNodeId | null) => void;
    selectNode: (draft: ResearchViewUiState, nodeId: ResearchViewNodeId | null) => void;
    accept: (draft: ResearchViewUiState, token: ResearchViewTargetToken, selection: ResearchViewSelection, nodeIds: readonly ResearchViewNodeId[]) => void;
    setCamera: (draft: ResearchViewUiState, key: string, camera: ArchifyCamera) => void;
}>;
//# sourceMappingURL=view-store.d.ts.map