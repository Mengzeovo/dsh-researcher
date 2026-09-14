import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { ResearchViewChanged, ResearchViewConfig, ResearchViewNodeDetail, ResearchViewNodeRequest, ResearchViewRendered, ResearchViewRenderRequest, ResearchViewRequest, ResearchViewResponse, ResearchViewWatchRequest } from './view-types.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        researchView: ResearchViewService;
    }
}
/** Activated explicitly by researcher view.enabled; never creates or resumes an Agent or Goal. */
export declare class ResearchViewService extends TypertRemoteService {
    private readonly config;
    static inject: string[];
    static Config: import("zod").ZodType<ResearchViewConfig, unknown, import("zod/v4/core").$ZodTypeInternals<ResearchViewConfig, unknown>>;
    private readonly cache;
    private readonly lifetime;
    private readonly pending;
    private readonly salt;
    constructor(ctx: Context, config: ResearchViewConfig);
    /** @param request - Session identity and optional page selection. @param signal - Cancels this read. @returns One bounded graph page or an unchanged/unbound marker. */
    getView(request: ResearchViewRequest, signal?: AbortSignal): Promise<ResearchViewResponse>;
    /** @param request - Node on a cached page belonging to this Session's bound target. @param signal - Cancels this read. @returns The verified plan document or raw Run JSON. */
    getViewNode(request: ResearchViewNodeRequest, signal?: AbortSignal): Promise<ResearchViewNodeDetail>;
    /** @param request - Cached page identity, theme, and diagram language. @param signal - Cancels the native render. @returns A versioned artifact, not a workspace file or authority record. */
    renderView(request: ResearchViewRenderRequest, signal?: AbortSignal): Promise<ResearchViewRendered>;
    /** @param request - Observed Session identity. @param signal - Ends the subscription. @returns Coalesced invalidation hints; the first item closes the read/subscribe race. */
    watchView(request: ResearchViewWatchRequest, signal?: AbortSignal): AsyncIterable<ResearchViewChanged>;
    private scope;
    private current;
    private targetToken;
    private stale;
    private evict;
    private assertSize;
    private execute;
}
export default ResearchViewService;
//# sourceMappingURL=view-service.d.ts.map