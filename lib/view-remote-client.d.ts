/** Optional read-only research view Remote assembly; activated with the native Viewer. */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { ResearchViewChanged, ResearchViewNodeDetail, ResearchViewNodeRequest, ResearchViewRenderRequest, ResearchViewRendered, ResearchViewRequest, ResearchViewResponse, ResearchViewWatchRequest } from './view-types.ts';
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteNamespaceMap {
        researchView: {
            getView(request: ResearchViewRequest, signal?: AbortSignal): Promise<RemoteResult<ResearchViewResponse>>;
            getViewNode(request: ResearchViewNodeRequest, signal?: AbortSignal): Promise<RemoteResult<ResearchViewNodeDetail>>;
            renderView(request: ResearchViewRenderRequest, signal?: AbortSignal): Promise<RemoteResult<ResearchViewRendered>>;
            watchView(request: ResearchViewWatchRequest, signal?: AbortSignal): AsyncIterable<RemoteResult<ResearchViewChanged>>;
        };
    }
    interface TypertRemoteMap {
        'researchView/getView': TypertRemoteNamespaceMap['researchView']['getView'];
        'researchView/getViewNode': TypertRemoteNamespaceMap['researchView']['getViewNode'];
        'researchView/renderView': TypertRemoteNamespaceMap['researchView']['renderView'];
        'researchView/watchView': TypertRemoteNamespaceMap['researchView']['watchView'];
    }
}
export declare const TYPERT_REMOTE: {
    package: string;
    descriptors: readonly import("@deepseek-ai/dsh-typert-protocol").InvocationDescriptor[];
};
export default TYPERT_REMOTE;
//# sourceMappingURL=view-remote-client.d.ts.map