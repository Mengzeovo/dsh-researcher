/** Session-owned read controller; request generations exclude late RPC answers. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
const initial = {
    phase: 'idle', snapshot: null, artifact: null, artifactAppearance: null, rendering: false,
    detail: null, detailLoading: false, targets: null, targetsLoading: false, error: null, watchError: null,
};
const message = (error) => error instanceof Error ? error.message : String(error);
/** Stable key for server-owned pagination; camera identity excludes snapshot revisions. */
export function viewPageKey(selection) {
    return JSON.stringify([selection.planId,
        Object.entries(selection.runPages).sort(([a], [b]) => a.localeCompare(b))]);
}
/** One current snapshot/render cache, scoped to a live Session binding. */
export class ResearchViewController {
    sessionId;
    api;
    acceptSnapshot;
    watchRetryBaseMs;
    source = createSnapshotStore(initial);
    generation = 0;
    detailGeneration = 0;
    queryAbort;
    detailAbort;
    targetsAbort;
    watchAbort;
    watchTarget;
    pendingKey;
    query;
    last;
    cachedRender;
    reloadQueued = false;
    watchRetryQueued = false;
    watchRetryCount = 0;
    watchTimer;
    active = false;
    disposed = false;
    constructor(sessionId, api, acceptSnapshot, watchRetryBaseMs = 1000) {
        this.sessionId = sessionId;
        this.api = api;
        this.acceptSnapshot = acceptSnapshot;
        this.watchRetryBaseMs = watchRetryBaseMs;
    }
    /** Entering a remounted page always checks Host state without discarding UI selection. */
    enter(selection, appearance) {
        this.active = true;
        return this.load(selection, appearance, true);
    }
    /** Stop presentation-only work when the View leaves; the binding keeps its read cache. */
    leave() {
        this.active = false;
        this.stopWatch();
        this.reloadQueued = false;
        this.cancelQuery();
        this.cancelDetail();
        this.targetsAbort?.abort();
        this.patch({ targetsLoading: false, detailLoading: false, rendering: false });
    }
    /** A Host notification can also represent rebinding, so active pages recheck every token. */
    invalidate(resetRender = false) {
        if (resetRender) {
            this.stopWatch();
            this.cachedRender = undefined;
            this.reloadQueued = false;
            this.cancelQuery();
        }
        if (this.active && this.last !== undefined)
            void this.loadPage(this.last.selection, this.last.appearance, true, resetRender);
    }
    /** Fetch a selected Host page, then render exactly that immutable snapshot. */
    load(selection, appearance, force = false) {
        return this.loadPage(selection, appearance, force, force);
    }
    loadPage(selection, appearance, force, retryWatch) {
        if (this.disposed)
            return Promise.resolve();
        this.last = { selection, appearance };
        const key = this.requestKey(selection, appearance);
        if (this.pendingKey === key && this.query !== undefined) {
            if (force) {
                this.reloadQueued = true;
                this.watchRetryQueued ||= retryWatch;
            }
            return this.query;
        }
        const before = this.source.getSnapshot();
        if (!force && before.phase === 'ready' && before.snapshot !== null
            && this.requestKey(before.snapshot.selection, appearance) === key
            && (before.snapshot.nodes.length === 0
                || this.cachedRender?.key === this.renderKey(before.snapshot, appearance)))
            return Promise.resolve();
        this.cancelQuery();
        const generation = ++this.generation;
        const abort = new AbortController();
        this.queryAbort = abort;
        this.pendingKey = key;
        this.patch({ phase: 'loading', error: null });
        const run = this.fetch(selection, appearance, force, retryWatch, generation, abort);
        this.query = run;
        return run;
    }
    /** Only ids present in the currently accepted snapshot may cross the detail RPC. */
    async selectNode(id) {
        this.cancelDetail();
        const snapshot = this.source.getSnapshot().snapshot;
        const node = snapshot?.nodes.find(item => item.id === id);
        if (this.disposed || snapshot === null || node === undefined) {
            this.patch({ detail: null, detailLoading: false });
            return;
        }
        const generation = ++this.detailGeneration;
        const abort = new AbortController();
        this.detailAbort = abort;
        this.patch({ detail: null, detailLoading: true });
        try {
            const detail = await this.api.getViewNode({ sessionId: this.sessionId,
                snapshotId: snapshot.snapshotId, nodeId: node.id }, abort.signal);
            if (this.disposed || abort.signal.aborted || generation !== this.detailGeneration
                || this.source.getSnapshot().snapshot?.snapshotId !== snapshot.snapshotId)
                return;
            if (detail.node.id !== node.id)
                throw new Error('research-view/detail-node-mismatch');
            this.patch({ detail, detailLoading: false });
        }
        catch (error) {
            if (!this.disposed && !abort.signal.aborted && generation === this.detailGeneration) {
                this.patch({ detailLoading: false, error: message(error) });
            }
        }
    }
    /** Query the existing research-load roster, not an Agent construction endpoint. */
    async listTargets() {
        if (this.disposed)
            return;
        this.targetsAbort?.abort();
        const abort = new AbortController();
        this.targetsAbort = abort;
        this.patch({ targetsLoading: true, error: null });
        try {
            const targets = await this.api.listTargets(abort.signal);
            if (!this.disposed && !abort.signal.aborted)
                this.patch({ targets, targetsLoading: false });
        }
        catch (error) {
            if (!this.disposed && !abort.signal.aborted)
                this.patch({ targetsLoading: false, error: message(error) });
        }
    }
    /** The click must name a valid row returned by the existing roster endpoint. */
    async loadTarget(id) {
        if (this.disposed || this.source.getSnapshot().targetsLoading
            || !this.source.getSnapshot().targets?.targets.some(target => target.id === id))
            return;
        this.patch({ targetsLoading: true, error: null });
        try {
            await this.api.loadTarget(id);
            if (this.disposed)
                return;
            this.patch({ targets: null, targetsLoading: false });
            if (this.active && this.last !== undefined)
                await this.load(this.last.selection, this.last.appearance, true);
        }
        catch (error) {
            if (!this.disposed)
                this.patch({ targetsLoading: false, error: message(error) });
        }
    }
    dispose() {
        this.leave();
        this.disposed = true;
        this.cachedRender = undefined;
    }
    async fetch(selection, appearance, force, retryWatch, generation, abort) {
        const current = () => !this.disposed && !abort.signal.aborted && generation === this.generation;
        try {
            const previous = this.source.getSnapshot().snapshot;
            const samePage = previous !== null && viewPageKey(previous.selection) === viewPageKey(selection);
            const response = await this.api.getView({ sessionId: this.sessionId,
                ...(selection.planId === null ? {} : { planId: selection.planId,
                    runPages: selection.runPages }),
                ...(samePage ? { ifNoneMatch: previous.snapshotId } : {}), refresh: force }, abort.signal);
            if (!current())
                return;
            if (response.kind === 'unbound') {
                this.stopWatch();
                this.cancelDetail();
                this.cachedRender = undefined;
                this.patch({ phase: 'unbound', snapshot: null, artifact: null, artifactAppearance: null,
                    detail: null, detailLoading: false, rendering: false, watchError: null });
                return;
            }
            const snapshot = response.kind === 'unchanged' ? previous : response;
            if (snapshot === null || (response.kind === 'unchanged' && response.snapshotId !== snapshot.snapshotId)) {
                throw new Error('research-view/unchanged-without-snapshot');
            }
            const changed = snapshot.snapshotId !== previous?.snapshotId;
            if (changed)
                this.cancelDetail();
            const renderKey = this.renderKey(snapshot, appearance);
            const cached = this.cachedRender?.key === renderKey ? this.cachedRender.artifact : null;
            this.patch({ snapshot, artifact: cached, artifactAppearance: cached === null ? null : appearance, phase: 'ready',
                ...(changed ? { detail: null, detailLoading: false } : {}),
                rendering: snapshot.nodes.length > 0 && cached === null });
            this.pendingKey = this.requestKey(snapshot.selection, appearance);
            this.last = { selection: snapshot.selection, appearance };
            this.acceptSnapshot(snapshot);
            this.startWatch(snapshot.targetToken, retryWatch);
            if (snapshot.nodes.length === 0 || cached !== null)
                return;
            const artifact = await this.api.renderView({ sessionId: this.sessionId,
                snapshotId: snapshot.snapshotId, ...appearance }, abort.signal);
            if (!current())
                return;
            this.cachedRender = { key: renderKey, artifact };
            this.patch({ artifact, artifactAppearance: appearance, rendering: false });
        }
        catch (error) {
            if (current())
                this.patch({ phase: 'error', rendering: false, error: message(error) });
        }
        finally {
            if (current()) {
                this.pendingKey = undefined;
                this.query = undefined;
                if (this.reloadQueued && this.active && this.last !== undefined) {
                    const retry = this.watchRetryQueued;
                    this.reloadQueued = false;
                    this.watchRetryQueued = false;
                    void this.loadPage(this.last.selection, this.last.appearance, true, retry);
                }
            }
        }
    }
    /** Subscribe only after a bound read; the first Host hint closes the read/subscribe race. */
    startWatch(target, retry) {
        if (this.disposed || !this.active)
            return;
        if (this.watchTarget !== target) {
            this.stopWatch();
            this.watchTarget = target;
            this.watchRetryCount = 0;
            this.patch({ watchError: null });
        }
        if (retry && this.watchTimer !== undefined) {
            clearTimeout(this.watchTimer);
            this.watchTimer = undefined;
        }
        if (this.watchAbort !== undefined || this.watchTimer !== undefined
            || (!retry && this.source.getSnapshot().watchError !== null))
            return;
        const abort = new AbortController();
        this.watchAbort = abort;
        this.patch({ watchError: null });
        void this.consumeWatch(abort);
    }
    async consumeWatch(abort) {
        const current = () => !this.disposed && this.active && !abort.signal.aborted && this.watchAbort === abort;
        try {
            for await (const _changed of this.api.watchView(abort.signal)) {
                if (!current())
                    break;
                this.watchRetryCount = 0;
                this.invalidate();
            }
            if (current())
                this.scheduleWatchRetry('research-view/watch-ended');
        }
        catch (error) {
            if (current())
                this.scheduleWatchRetry(message(error));
        }
        finally {
            if (this.watchAbort === abort)
                this.watchAbort = undefined;
        }
    }
    /** A disconnected stream resubscribes with backoff while the page stays active. */
    scheduleWatchRetry(reason) {
        this.patch({ watchError: reason });
        if (this.disposed || !this.active || this.watchTarget === undefined)
            return;
        const delay = Math.min(30_000, this.watchRetryBaseMs * 2 ** this.watchRetryCount++);
        clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
            this.watchTimer = undefined;
            if (this.disposed || !this.active || this.watchTarget === undefined || this.watchAbort !== undefined)
                return;
            const abort = new AbortController();
            this.watchAbort = abort;
            this.patch({ watchError: null });
            void this.consumeWatch(abort);
        }, delay);
    }
    stopWatch() {
        clearTimeout(this.watchTimer);
        this.watchTimer = undefined;
        this.watchAbort?.abort();
        this.watchAbort = undefined;
        this.watchTarget = undefined;
        this.watchRetryCount = 0;
    }
    cancelQuery() {
        ++this.generation;
        this.watchRetryQueued = false;
        this.queryAbort?.abort();
        this.pendingKey = undefined;
        this.query = undefined;
    }
    cancelDetail() {
        ++this.detailGeneration;
        this.detailAbort?.abort();
    }
    renderKey(snapshot, appearance) {
        return JSON.stringify([snapshot.snapshotId, appearance.theme, appearance.locale]);
    }
    requestKey(selection, appearance) {
        return JSON.stringify([viewPageKey(selection), appearance.theme, appearance.locale]);
    }
    patch(patch) {
        if (!this.disposed)
            this.source.set({ ...this.source.getSnapshot(), ...patch });
    }
}
//# sourceMappingURL=view-controller.js.map