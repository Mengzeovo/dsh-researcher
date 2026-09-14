import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchViewController, type ResearchViewClientApi } from '../src/client/view-controller.ts'
import { createResearchViewStore } from '../src/client/view-store.ts'
import type { ResearchId } from '../src/types.ts'
import type { ResearchViewChanged, ResearchViewArtifactId, ResearchPlanViewNode, ResearchViewNodeDetail, ResearchViewNodeId, ResearchViewRendered,
  ResearchViewResponse, ResearchViewSelection, ResearchViewSnapshot, ResearchViewSnapshotId, ResearchViewTargetToken } from '../src/view-types.ts'

const appearance = { theme: 'light', locale: 'en' } as const
const selection: ResearchViewSelection = { planId: 1, versionPage: 0, runPages: {} }
const node: ResearchPlanViewNode = { id: 'plan:1:1' as ResearchViewNodeId, kind: 'plan', planId: 1,
  revision: 1, title: 'Initial proposal', summary: 'Test evidence', path: 'plans/1.md', createdAt: '2026-09-01',
  column: 0, slot: 0, selected: true, sha256: 'abc' }
function snapshot(id = 's1', page: ResearchViewSelection = selection): ResearchViewSnapshot {
  return { kind: 'ready', snapshotId: id as ResearchViewSnapshotId, targetToken: 'target' as ResearchViewTargetToken,
    researchId: 'research' as ResearchId, goal: { goal: 'Measure results', description: 'Fixture', markdown: '', metrics: '', baseline: '' },
    state: { version: 1, revision: 1, at: '2026-09-01', sessionId: 'session', status: 'active', summary: 'Ready' },
    groups: [{ planId: 1, title: 'Initial proposal', latestRevision: 1, revisionCount: 1, runCount: 0, warningCount: 0 }],
    selection: page, pages: { versionPages: 1, versionsPerPage: 3, runsPerVersionPage: 4, runCounts: { '1': 0 } },
    nodes: [node], edges: [], outsideLinks: [], diagnostics: [] }
}
function artifact(revision: ResearchViewSnapshotId): ResearchViewRendered {
  return { html: '<html></html>', svg: '<svg/>', revision: ('artifact-' + revision) as ResearchViewArtifactId, nodeIds: [node.id], specSha256: 'spec', engineFingerprint: 'engine' }
}
const detail: ResearchViewNodeDetail = { kind: 'plan', node, document: {
  metadata: { schema_version: 1, plan_id: 1, revision: 1, title: node.title, created_at: node.createdAt, delta: [] },
  body: 'Evidence body', markdown: '# Evidence', sha256: node.sha256,
} }
const owned: ResearchViewController[] = []
afterEach(() => { for (const controller of owned.splice(0)) controller.dispose() })
function bench(overrides: Partial<ResearchViewClientApi> = {}, watchRetryBaseMs?: number) {
  const api = {
    watchView: vi.fn<ResearchViewClientApi['watchView']>().mockImplementation(async function* (signal) {
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }),
    getView: vi.fn<ResearchViewClientApi['getView']>().mockResolvedValue(snapshot()),
    getViewNode: vi.fn<ResearchViewClientApi['getViewNode']>().mockResolvedValue(detail),
    renderView: vi.fn<ResearchViewClientApi['renderView']>().mockImplementation(async request => artifact(request.snapshotId)),
    listTargets: vi.fn<ResearchViewClientApi['listTargets']>().mockResolvedValue({ version: 1, targets: [], invalid: [] }),
    loadTarget: vi.fn<ResearchViewClientApi['loadTarget']>().mockResolvedValue(undefined),
  }
  const accept = vi.fn()
  const controller = new ResearchViewController('session', { ...api, ...overrides }, accept, watchRetryBaseMs)
  owned.push(controller)
  return { controller, api, accept }
}

describe('Research View read controller', () => {
  it('fetches then renders once and reuses the identical snapshot render on refresh', async () => {
    const b = bench()
    const source = b.controller.source
    expect(source.getSnapshot()).toBe(source.getSnapshot())
    await b.controller.enter(selection, appearance)
    expect(b.api.renderView).toHaveBeenCalledTimes(1)
    b.api.getView.mockResolvedValue({ kind: 'unchanged', snapshotId: 's1' as ResearchViewSnapshotId })
    await b.controller.load(selection, appearance, true)
    expect(b.api.getView.mock.lastCall?.[0].ifNoneMatch).toBe('s1')
    expect(b.api.renderView).toHaveBeenCalledTimes(1)
    expect(b.controller.source).toBe(source)
    expect(source.getSnapshot().phase).toBe('ready')
    await b.controller.load(selection, { theme: 'dark', locale: 'zh-CN' })
    expect(b.api.renderView).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot().artifactAppearance).toEqual({ theme: 'dark', locale: 'zh-CN' })
  })
  it('discards a late page answer even when the transport ignores AbortSignal', async () => {
    const first = Promise.withResolvers<ResearchViewResponse>()
    const b = bench()
    b.api.getView.mockReturnValueOnce(first.promise).mockResolvedValueOnce(snapshot('s2', { ...selection, planId: 2 }))
    const old = b.controller.enter(selection, appearance)
    await b.controller.load({ ...selection, planId: 2 }, appearance)
    expect(b.api.getView.mock.calls[0]?.[1].aborted).toBe(true)
    first.resolve(snapshot())
    await old
    expect(b.controller.source.getSnapshot().snapshot?.snapshotId).toBe('s2')
    expect(b.api.renderView).toHaveBeenCalledTimes(1)
  })
  it('keeps a late render from replacing the next selected page', async () => {
    const rendering = Promise.withResolvers<ResearchViewRendered>()
    const b = bench()
    b.api.renderView.mockReturnValueOnce(rendering.promise)
    const old = b.controller.enter(selection, appearance)
    await vi.waitFor(() => expect(b.api.renderView).toHaveBeenCalledTimes(1))
    b.api.getView.mockResolvedValue(snapshot('s2', { ...selection, versionPage: 1 }))
    await b.controller.load({ ...selection, versionPage: 1 }, appearance)
    rendering.resolve(artifact('s1' as ResearchViewSnapshotId))
    await old
    expect(b.controller.source.getSnapshot().artifact?.revision).toBe('artifact-s2')
  })
  it('verifies node membership and discards detail after a snapshot replacement', async () => {
    const pending = Promise.withResolvers<ResearchViewNodeDetail>()
    const b = bench()
    await b.controller.enter(selection, appearance)
    await b.controller.selectNode('arbitrary-id')
    expect(b.api.getViewNode).not.toHaveBeenCalled()
    b.api.getViewNode.mockReturnValueOnce(pending.promise)
    const old = b.controller.selectNode(node.id)
    b.api.getView.mockResolvedValue(snapshot('s2'))
    await b.controller.load(selection, appearance, true)
    pending.resolve(detail)
    await old
    expect(b.controller.source.getSnapshot().detail).toBeNull()
    await b.controller.selectNode(node.id)
    expect(b.api.getViewNode.mock.lastCall?.[0].snapshotId).toBe('s2')
    expect(b.controller.source.getSnapshot().detail?.node.id).toBe(node.id)
  })
  it('coalesces changes during a request and refreshes only while the View is active', async () => {
    const first = Promise.withResolvers<ResearchViewResponse>()
    const b = bench()
    b.api.getView.mockReturnValueOnce(first.promise).mockResolvedValue(snapshot('s2'))
    const entering = b.controller.enter(selection, appearance)
    b.controller.invalidate()
    b.controller.invalidate()
    first.resolve(snapshot())
    await entering
    await vi.waitFor(() => expect(b.controller.source.getSnapshot().artifact?.revision).toBe('artifact-s2'))
    expect(b.api.getView).toHaveBeenCalledTimes(2)
    b.controller.leave()
    b.controller.invalidate()
    expect(b.api.getView).toHaveBeenCalledTimes(2)
    await b.controller.enter(selection, appearance)
    expect(b.api.getView).toHaveBeenCalledTimes(3)
  })
  it('invalidates an in-flight renderer on connection reset even for an unchanged snapshot', async () => {
    const oldRender = Promise.withResolvers<ResearchViewRendered>()
    const b = bench()
    const fresh = { ...artifact('s1' as ResearchViewSnapshotId), revision: 'new-engine' as ResearchViewArtifactId }
    b.api.renderView.mockReturnValueOnce(oldRender.promise).mockResolvedValueOnce(fresh)
    const entering = b.controller.enter(selection, appearance)
    await vi.waitFor(() => expect(b.api.renderView).toHaveBeenCalledTimes(1))
    b.controller.invalidate(true)
    await vi.waitFor(() => expect(b.controller.source.getSnapshot().artifact?.revision).toBe('new-engine'))
    expect(b.api.renderView.mock.calls[0]?.[1].aborted).toBe(true)
    oldRender.resolve(artifact('s1' as ResearchViewSnapshotId))
    await entering
    expect(b.controller.source.getSnapshot().artifact?.revision).toBe('new-engine')
  })
  it('uses stream events for refresh without reopening the stream on each snapshot', async () => {
    const event = Promise.withResolvers<ResearchViewChanged>()
    const b = bench()
    b.api.watchView.mockImplementationOnce(async function* (signal) {
      yield await event.promise
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    await b.controller.enter(selection, appearance)
    event.resolve({ targetToken: 'new-binding' as ResearchViewTargetToken })
    await vi.waitFor(() => expect(b.api.getView).toHaveBeenCalledTimes(2))
    expect(b.api.watchView).toHaveBeenCalledTimes(1)
    b.controller.leave()
    expect(b.api.watchView.mock.calls[0]?.[0].aborted).toBe(true)
    await b.controller.enter(selection, appearance)
    expect(b.api.watchView).toHaveBeenCalledTimes(2)
  })
  it('resubscribes with backoff after stream failures and ignores late events after leaving', async () => {
    const event = Promise.withResolvers<ResearchViewChanged>()
    const b = bench({}, 5)
    b.api.watchView.mockImplementationOnce(async function* () { throw new Error('stream offline') })
      .mockImplementationOnce(async function* () { yield await event.promise })
    await b.controller.enter(selection, appearance)
    await vi.waitFor(() => expect(b.controller.source.getSnapshot().watchError).toBe('stream offline'))
    await vi.waitFor(() => expect(b.api.watchView).toHaveBeenCalledTimes(2))
    expect(b.controller.source.getSnapshot().watchError).toBeNull()
    b.controller.leave()
    const count = b.api.getView.mock.calls.length
    event.resolve({ targetToken: 'late' as ResearchViewTargetToken })
    await Promise.resolve()
    await Promise.resolve()
    expect(b.api.getView).toHaveBeenCalledTimes(count)
  })
  it('does not subscribe before binding is known or while the page is unbound', async () => {
    const pending = Promise.withResolvers<ResearchViewResponse>()
    const b = bench()
    b.api.getView.mockReturnValueOnce(pending.promise).mockResolvedValue({ kind: 'unbound' })
    const entering = b.controller.enter(selection, appearance)
    expect(b.api.watchView).not.toHaveBeenCalled()
    pending.resolve({ kind: 'unbound' })
    await entering
    await b.controller.load(selection, appearance, true)
    b.controller.invalidate(true)
    await vi.waitFor(() => expect(b.controller.source.getSnapshot().phase).toBe('unbound'))
    expect(b.api.watchView).not.toHaveBeenCalled()
    expect(b.controller.source.getSnapshot().watchError).toBeNull()
  })
  it('subscribes after choosing a target and cancels the stream on disposal', async () => {
    const b = bench()
    b.api.getView.mockResolvedValueOnce({ kind: 'unbound' })
    await b.controller.enter(selection, appearance)
    b.api.listTargets.mockResolvedValue({ version: 1, targets: [{ id: 'chosen' as ResearchId,
      description: 'Chosen target', status: 'active', updatedAt: '', warningCount: 0 }], invalid: [] })
    await b.controller.listTargets()
    await b.controller.loadTarget('chosen')
    expect(b.controller.source.getSnapshot().phase).toBe('ready')
    expect(b.api.watchView).toHaveBeenCalledTimes(1)
    b.controller.dispose()
    expect(b.api.watchView.mock.calls[0]?.[0].aborted).toBe(true)
    expect(b.controller.source.getSnapshot().watchError).toBeNull()
  })
  it('cancels a bound stream on unbinding and ignores its late failure', async () => {
    const pending = Promise.withResolvers<void>()
    const b = bench()
    b.api.watchView.mockImplementationOnce(async function* () { await pending.promise })
    await b.controller.enter(selection, appearance)
    b.api.getView.mockResolvedValueOnce({ kind: 'unbound' })
    await b.controller.load(selection, appearance, true)
    expect(b.api.watchView.mock.calls[0]?.[0].aborted).toBe(true)
    pending.reject(new Error('late stream failure'))
    await Promise.resolve()
    await Promise.resolve()
    expect(b.controller.source.getSnapshot()).toMatchObject({ phase: 'unbound', watchError: null })
    await b.controller.load(selection, appearance, true)
    expect(b.api.watchView).toHaveBeenCalledTimes(2)
  })
  it('clears a previous stream failure when a refreshed page becomes unbound', async () => {
    const b = bench()
    b.api.watchView.mockImplementationOnce(async function* () { throw new Error('stream offline') })
    await b.controller.enter(selection, appearance)
    await vi.waitFor(() => expect(b.controller.source.getSnapshot().watchError).toBe('stream offline'))
    b.api.getView.mockResolvedValueOnce({ kind: 'unbound' })
    await b.controller.load(selection, appearance, true)
    expect(b.api.watchView).toHaveBeenCalledTimes(1)
    expect(b.controller.source.getSnapshot()).toMatchObject({ phase: 'unbound', watchError: null })
  })
  it('replaces the old target subscription when a read observes a different binding', async () => {
    const b = bench()
    await b.controller.enter(selection, appearance)
    b.api.getView.mockResolvedValue({ ...snapshot('s2'), targetToken: 'new-target' as ResearchViewTargetToken })
    await b.controller.load(selection, appearance, true)
    expect(b.api.watchView.mock.calls[0]?.[0].aborted).toBe(true)
    expect(b.api.watchView).toHaveBeenCalledTimes(2)
    expect(b.api.watchView.mock.calls[1]?.[0].aborted).toBe(false)
  })
  it('reconnects after unexpected stream completion without waiting for explicit refresh', async () => {
    const b = bench({}, 5)
    const seen: (string | null)[] = []
    const stop = b.controller.source.subscribe(() => seen.push(b.controller.source.getSnapshot().watchError))
    b.api.watchView.mockImplementationOnce(async function* () {
      yield { targetToken: 'target' as ResearchViewTargetToken }
    })
    await b.controller.enter(selection, appearance)
    await vi.waitFor(() => expect(seen).toContain('research-view/watch-ended'))
    // Non-forced loads and invalidations never open a second stream while a retry is pending.
    await b.controller.load({ ...selection, versionPage: 1 }, appearance)
    b.controller.invalidate()
    await vi.waitFor(() => expect(b.controller.source.getSnapshot().phase).toBe('ready'))
    // The backoff timer resubscribes on its own and clears the disconnect state.
    await vi.waitFor(() => expect(b.api.watchView).toHaveBeenCalledTimes(2))
    expect(b.controller.source.getSnapshot().watchError).toBeNull()
    stop()
  })
  it('adopts Host-normalized pagination without aborting its pending render', async () => {
    const pending = Promise.withResolvers<ResearchViewRendered>()
    const b = bench()
    b.api.renderView.mockReturnValueOnce(pending.promise)
    const first = b.controller.enter({ planId: null, versionPage: 0, runPages: {} }, appearance)
    await vi.waitFor(() => expect(b.api.renderView).toHaveBeenCalledTimes(1))
    const normalized = b.controller.load(selection, appearance)
    expect(b.api.getView).toHaveBeenCalledTimes(1)
    expect(b.api.getView.mock.calls[0]?.[0]).not.toHaveProperty('versionPage')
    expect(b.api.getView.mock.calls[0]?.[0]).not.toHaveProperty('runPages')
    expect(b.api.renderView.mock.calls[0]?.[1].aborted).toBe(false)
    pending.resolve(artifact('s1' as ResearchViewSnapshotId))
    await Promise.all([first, normalized])
  })
  it('renders neither unbound nor empty snapshots and reports transport failure', async () => {
    const b = bench()
    b.api.getView.mockResolvedValueOnce({ kind: 'unbound' })
    await b.controller.enter(selection, appearance)
    expect(b.controller.source.getSnapshot().phase).toBe('unbound')
    b.api.getView.mockResolvedValueOnce({ ...snapshot(), kind: 'empty', nodes: [] })
    await b.controller.load(selection, appearance, true)
    expect(b.api.renderView).not.toHaveBeenCalled()
    b.api.getView.mockRejectedValueOnce(new Error('offline'))
    await b.controller.load(selection, appearance, true)
    expect(b.controller.source.getSnapshot()).toMatchObject({ phase: 'error', error: 'offline' })
  })
  it('contains cancellations and never publishes a late answer after disposal', async () => {
    const pending = Promise.withResolvers<ResearchViewResponse>()
    const b = bench()
    b.api.getView.mockReturnValueOnce(pending.promise)
    const query = b.controller.enter(selection, appearance)
    b.controller.dispose()
    const atDisposal = b.controller.source.getSnapshot()
    pending.resolve(snapshot())
    await query
    expect(b.controller.source.getSnapshot()).toBe(atDisposal)
    expect(b.api.renderView).not.toHaveBeenCalled()
  })
  it('loads only valid targets returned by the existing target roster', async () => {
    const b = bench()
    b.api.getView.mockResolvedValue({ kind: 'unbound' })
    await b.controller.enter(selection, appearance)
    await b.controller.loadTarget('not-listed')
    expect(b.api.loadTarget).not.toHaveBeenCalled()
    b.api.listTargets.mockResolvedValue({ version: 1, targets: [{ id: 'chosen' as ResearchId,
      description: 'Chosen target', status: 'active', updatedAt: '', warningCount: 0 }], invalid: [] })
    await b.controller.listTargets()
    await b.controller.loadTarget('chosen')
    expect(b.api.loadTarget).toHaveBeenCalledWith('chosen')
  })
})

describe('Research View navigation store', () => {
  it('retains pages and cameras while data refreshes without selecting the newest node', () => {
    const store = createResearchViewStore().create()
    const token = 'target' as ResearchViewTargetToken
    store.actions.accept(token, selection, [node.id])
    store.actions.selectNode(node.id)
    store.actions.setCamera('page', { scale: 2, x: 10, y: 20, mode: 'manual' })
    store.actions.accept(token, { ...selection }, [node.id, 'new-node' as ResearchViewNodeId])
    expect(store.store.getSnapshot().selectedNodeId).toBe(node.id)
    store.actions.selectPage({ ...selection, versionPage: 1 })
    store.actions.selectPlan(2)
    store.actions.selectPlan(1)
    expect(store.store.getSnapshot().selection.versionPage).toBe(1)
    expect(store.store.getSnapshot().cameras.page?.scale).toBe(2)
    store.actions.accept('replacement' as ResearchViewTargetToken, selection, [node.id])
    expect(store.store.getSnapshot().cameras).toEqual({})
    expect(store.store.getSnapshot().selectedNodeId).toBeNull()
  })
})
