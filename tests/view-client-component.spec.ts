// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ArchifyViewerProps } from 'dsh-archify-native/types'
import { ResearchView } from '../src/client/ResearchView.tsx'
import { createResearchViewStore } from '../src/client/view-store.ts'
import { ResearchViewController, viewPageKey } from '../src/client/view-controller.ts'
import type { ResearchViewClientState } from '../src/client/view-controller.ts'
import type { ResearchViewProps } from '../src/client/view-contract.ts'
import { en, zh } from '../src/client/view-locales.ts'
import type { ResearchId, RunId } from '../src/types.ts'
import type { ResearchViewArtifactId, ResearchPlanViewNode, ResearchRunViewNode, ResearchViewNodeId, ResearchViewSnapshot,
  ResearchViewSnapshotId, ResearchViewTargetToken } from '../src/view-types.ts'

afterEach(cleanup)
const plan: ResearchPlanViewNode = { id: 'plan:1:1' as ResearchViewNodeId, kind: 'plan', planId: 1, revision: 1,
  title: 'Measure throughput', summary: 'Plan evidence', path: 'plans/1.md', createdAt: '2026-09-01',
  column: 0, slot: 0, selected: true, sha256: 'abc' }
const run: ResearchRunViewNode = { ...plan, id: 'run:1' as ResearchViewNodeId, kind: 'run',
  title: 'First probe', runId: 'run-1' as RunId, status: 'unsealed', pendingState: true, metrics: { score: 4 } }
const snapshot: ResearchViewSnapshot = {
  kind: 'ready', snapshotId: 's1' as ResearchViewSnapshotId, targetToken: 'target' as ResearchViewTargetToken,
  researchId: 'research' as ResearchId,
  goal: { goal: 'Measure throughput', description: 'Research fixture', markdown: '', metrics: '', baseline: '' },
  state: { version: 1, revision: 1, at: '', sessionId: 'session', status: 'active', summary: 'Ready' },
  groups: [{ planId: 1, title: 'Measure throughput', latestRevision: 7, revisionCount: 7, runCount: 5, warningCount: 0 },
    { planId: 2, title: 'Compare latency', latestRevision: 1, revisionCount: 1, runCount: 0, warningCount: 0 }],
  selection: { planId: 1, versionPage: 0, runPages: { '1': 0 } },
  pages: { versionPages: 3, versionsPerPage: 3, runsPerVersionPage: 4, runCounts: { '1': 5 } },
  nodes: [plan, run], edges: [{ id: 'uses', kind: 'uses-plan', from: run.id, to: plan.id, label: '' }],
  outsideLinks: [{ edge: { id: 'outside', kind: 'informs-plan', from: run.id, to: 'plan:2:1' as ResearchViewNodeId, label: '' },
    nodeId: 'plan:2:1' as ResearchViewNodeId, selection: { planId: 2, versionPage: 0, runPages: {} } }], diagnostics: [],
}
function bench(ready = true) {
  const controller = new ResearchViewController('unused', {} as never, () => {})
  let state: ResearchViewClientState = { ...controller.source.getSnapshot(), phase: ready ? 'ready' : 'unbound',
    snapshot: ready ? snapshot : null, artifact: ready ? { html: '<html/>', svg: '<svg/>', revision: 'render-s1' as ResearchViewArtifactId,
      nodeIds: snapshot.nodes.map(node => node.id), specSha256: 'spec', engineFingerprint: 'engine' } : null,
    artifactAppearance: ready ? { theme: 'light', locale: 'en' } : null }
  controller.dispose()
  const store = createResearchViewStore().create()
  store.actions.accept(snapshot.targetToken, snapshot.selection, snapshot.nodes.map(node => node.id))
  let language: 'en' | 'zh' = 'en'
  const native: ArchifyViewerProps[] = []
  const callbacks = { completeViewRequest: vi.fn(), enter: vi.fn().mockResolvedValue(undefined), leave: vi.fn(), load: vi.fn().mockResolvedValue(undefined),
    inspectNode: vi.fn().mockResolvedValue(undefined), listTargets: vi.fn().mockResolvedValue(undefined), loadTarget: vi.fn().mockResolvedValue(undefined) }
  // The fixture supplies only the standing seats this props-only component consumes.
  const props = {
    ...callbacks, viewRequest: null, actions: store.actions,
    useStore: (select: (value: ReturnType<typeof store.store.getSnapshot>) => unknown) => select(store.store.getSnapshot()),
    useResearchView: (select: (value: ResearchViewClientState) => unknown) => select(state),
    useResearchTheme: (select: (value: { active: { colorScheme: string } }) => unknown) => select({ active: { colorScheme: 'light' } }),
    useResearchLocale: (select: (value: { active: string }) => unknown) => select({ active: language }),
    renderSlot: (name: string, owner: ArchifyViewerProps) => {
      expect(name).toBe('research.view.diagram')
      native.push(owner)
      return createElement('div', { 'data-testid': 'native-viewer' })
    },
    t: (key: keyof typeof en, params: Record<string, unknown> = {}) => (language === 'en' ? en : zh)[key]
      .replace(/[{]([^}]+)[}]/g, (_all, name: string) => String(params[name] ?? '')),
  } as unknown as ResearchViewProps
  const view = render(createElement(ResearchView, props))
  return { ...callbacks, store, native, view,
    refresh: (patch: Partial<ResearchViewClientState> = {}) => { state = { ...state, ...patch }; view.rerender(createElement(ResearchView, props)) },
    language: (next: 'en' | 'zh') => { language = next },
    requestFocus: (focus: string) => { props.viewRequest = { view: 'research-view', focus }; view.rerender(createElement(ResearchView, props)) },
    state: () => state,
  }
}

describe('Research View presentation', () => {
  it('uses the existing research-load action in its unbound empty state', () => {
    const b = bench(false)
    expect(screen.getByText(en.unbound)).toBeTruthy()
    expect(screen.getByText(en.loadHint)).toBeTruthy()
    expect(screen.queryByTestId('native-viewer')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.loadTarget }))
    expect(b.listTargets).toHaveBeenCalledOnce()
    b.refresh({ targets: { version: 1, targets: [{ id: 'chosen' as ResearchId, description: 'Choose this target',
      status: 'active', updatedAt: '', warningCount: 0 }], invalid: [] } })
    fireEvent.click(screen.getByRole('button', { name: 'Choose this target' }))
    expect(b.loadTarget).toHaveBeenCalledWith('chosen')
  })
  it('mounts one Native slot and never promotes active/unsealed into running', () => {
    const b = bench()
    b.store.actions.selectNode(run.id)
    b.refresh()
    expect(screen.getAllByTestId('native-viewer')).toHaveLength(1)
    expect(screen.getByText(en['state.active'])).toBeTruthy()
    expect(screen.getByText(en['run.unsealed'])).toBeTruthy()
    expect(screen.getByText(en.pendingState)).toBeTruthy()
    expect(screen.queryByText(/running/i)).toBeNull()
    expect(b.native.at(-1)?.labels).toEqual({ title: en.diagram, fit: en.fit, downloadSvg: en.downloadSvg, unavailable: en.unavailable })
  })
  it('uses Host pagination sizes and outside-link destinations rather than regrouping records', () => {
    const b = bench()
    fireEvent.change(screen.getByRole('combobox', { name: en.planSelect }), { target: { value: '2' } })
    expect(b.store.store.getSnapshot().selection.planId).toBe(2)
    fireEvent.change(screen.getByRole('combobox', { name: en.planSelect }), { target: { value: '1' } })
    fireEvent.click(within(screen.getByRole('navigation', { name: en.versionPages })).getByRole('button', { name: /Next page/ }))
    expect(b.store.store.getSnapshot().selection.versionPage).toBe(1)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Runs for version 1' })).getByRole('button', { name: /Next page/ }))
    expect(b.store.store.getSnapshot().selection.runPages['1']).toBe(1)
    b.store.actions.selectNode(run.id)
    b.refresh()
    fireEvent.click(screen.getByRole('button', { name: 'Open linked page · Informs plan' }))
    expect(b.store.store.getSnapshot()).toMatchObject({ selection: snapshot.outsideLinks[0]?.selection, selectedNodeId: 'plan:2:1' })
  })
  it('validates Native node ids and keeps the camera and focus when records refresh', () => {
    const b = bench()
    b.native.at(-1)?.onNodeSelect?.('not-a-node')
    expect(b.store.store.getSnapshot().selectedNodeId).toBeNull()
    b.native.at(-1)?.onNodeSelect?.(plan.id)
    b.native.at(-1)?.onCameraChange?.({ scale: 2, x: 10, y: 12, mode: 'manual' })
    b.refresh()
    expect(b.inspectNode).toHaveBeenLastCalledWith(plan.id)
    expect(b.store.store.getSnapshot().cameras[viewPageKey(snapshot.selection)]?.scale).toBe(2)
    b.refresh({ snapshot: { ...snapshot, snapshotId: 's2' as ResearchViewSnapshotId } })
    expect(b.native.at(-1)?.selectedNodeId).toBe(plan.id)
    expect(b.native.at(-1)?.camera?.scale).toBe(2)
    b.view.unmount()
    expect(b.leave).toHaveBeenCalledOnce()
  })
  it('localizes all chrome and does not display HTML rendered for the previous locale', () => {
    const b = bench()
    b.language('zh')
    b.refresh()
    expect(screen.getByRole('button', { name: zh.refresh })).toBeTruthy()
    expect(screen.queryByTestId('native-viewer')).toBeNull()
    b.refresh({ artifactAppearance: { theme: 'light', locale: 'zh-CN' } })
    expect(b.native.at(-1)?.locale).toBe('zh-CN')
    expect(b.native.at(-1)?.labels?.downloadSvg).toBe(zh.downloadSvg)
  })
  it('consumes Conversation focus only when its id is present in the loaded snapshot', () => {
    const b = bench()
    b.requestFocus('unknown-node')
    expect(b.store.store.getSnapshot().selectedNodeId).toBeNull()
    expect(b.completeViewRequest).toHaveBeenCalledTimes(1)
    b.requestFocus(plan.id)
    expect(b.store.store.getSnapshot().selectedNodeId).toBe(plan.id)
    expect(b.completeViewRequest).toHaveBeenCalledTimes(2)
  })
  it('offers an inline retry indicator when live updates disconnect', () => {
    const b = bench()
    b.refresh({ watchError: 'stream offline' })
    fireEvent.click(screen.getByRole('button', { name: en.liveRetry }))
    expect(b.load).toHaveBeenLastCalledWith(snapshot.selection, { theme: 'light', locale: 'en' }, true)
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(b.load).toHaveBeenLastCalledWith(snapshot.selection, { theme: 'light', locale: 'en' }, true)
  })
  it('shows request errors as text without executing their markup', () => {
    const b = bench(false)
    b.refresh({ phase: 'error', error: '<img src=x onerror=alert(1)>' })
    expect(screen.getByRole('alert').textContent).toContain(en.error)
    expect(b.view.container.querySelector('img')).toBeNull()
  })
})
