import type { ResearchTargetList } from '../types.ts';
import type { ResearchViewChanged, ResearchViewNodeDetail, ResearchViewNodeRequest, ResearchViewRenderRequest, ResearchViewRendered, ResearchViewRequest, ResearchViewResponse, ResearchViewSelection, ResearchViewSnapshot } from '../view-types.ts';
export interface ViewAppearance {
    readonly theme: 'light' | 'dark';
    readonly locale: 'en' | 'zh-CN';
}
export interface ResearchViewClientApi {
    watchView(signal: AbortSignal): AsyncIterable<ResearchViewChanged>;
    getView(request: ResearchViewRequest, signal: AbortSignal): Promise<ResearchViewResponse>;
    getViewNode(request: ResearchViewNodeRequest, signal: AbortSignal): Promise<ResearchViewNodeDetail>;
    renderView(request: ResearchViewRenderRequest, signal: AbortSignal): Promise<ResearchViewRendered>;
    listTargets(signal: AbortSignal): Promise<ResearchTargetList>;
    loadTarget(id: string): Promise<void>;
}
export interface ResearchViewClientState {
    readonly phase: 'idle' | 'loading' | 'ready' | 'unbound' | 'error';
    readonly snapshot: ResearchViewSnapshot | null;
    readonly artifact: ResearchViewRendered | null;
    readonly artifactAppearance: ViewAppearance | null;
    readonly rendering: boolean;
    readonly detail: ResearchViewNodeDetail | null;
    readonly detailLoading: boolean;
    readonly targets: ResearchTargetList | null;
    readonly targetsLoading: boolean;
    readonly error: string | null;
    readonly watchError: string | null;
}
/** Stable key for server-owned pagination; camera identity excludes snapshot revisions. */
export declare function viewPageKey(selection: ResearchViewSelection): string;
/** One current snapshot/render cache, scoped to a live Session binding. */
export declare class ResearchViewController {
    private readonly sessionId;
    private readonly api;
    private readonly acceptSnapshot;
    private readonly watchRetryBaseMs;
    readonly source: import("@deepseek-ai/dsh-client-store").SnapshotStore<ResearchViewClientState>;
    private generation;
    private detailGeneration;
    private queryAbort;
    private detailAbort;
    private targetsAbort;
    private watchAbort;
    private watchTarget;
    private pendingKey;
    private query;
    private last;
    private cachedRender;
    private reloadQueued;
    private watchRetryQueued;
    private watchRetryCount;
    private watchTimer;
    private active;
    private disposed;
    constructor(sessionId: string, api: ResearchViewClientApi, acceptSnapshot: (snapshot: ResearchViewSnapshot) => void, watchRetryBaseMs?: number);
    /** Entering a remounted page always checks Host state without discarding UI selection. */
    enter(selection: ResearchViewSelection, appearance: ViewAppearance): Promise<void>;
    /** Stop presentation-only work when the View leaves; the binding keeps its read cache. */
    leave(): void;
    /** A Host notification can also represent rebinding, so active pages recheck every token. */
    invalidate(resetRender?: boolean): void;
    /** Fetch a selected Host page, then render exactly that immutable snapshot. */
    load(selection: ResearchViewSelection, appearance: ViewAppearance, force?: boolean): Promise<void>;
    private loadPage;
    /** Only ids present in the currently accepted snapshot may cross the detail RPC. */
    selectNode(id: string | null): Promise<void>;
    /** Query the existing research-load roster, not an Agent construction endpoint. */
    listTargets(): Promise<void>;
    /** The click must name a valid row returned by the existing roster endpoint. */
    loadTarget(id: string): Promise<void>;
    dispose(): void;
    private fetch;
    /** Subscribe only after a bound read; the first Host hint closes the read/subscribe race. */
    private startWatch;
    private consumeWatch;
    /** A disconnected stream resubscribes with backoff while the page stays active. */
    private scheduleWatchRetry;
    private stopWatch;
    private cancelQuery;
    private cancelDetail;
    private renderKey;
    private requestKey;
    private patch;
}
//# sourceMappingURL=view-controller.d.ts.map