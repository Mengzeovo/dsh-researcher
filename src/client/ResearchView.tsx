/** Props-only research browser. The Native plugin owns the sole diagram iframe. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Button, MarkdownText, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResearchViewNode } from '../view-types.ts'
import type { ResearchViewProps } from './view-contract.ts'
import { viewPageKey } from './view-controller.ts'

const panel: CSSProperties = { padding: 16, overflow: 'auto', minHeight: 0, minWidth: 0 }
const row: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }
const stack: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 8 }
const code: CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }
const muted: CSSProperties = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }
const border = '1px solid var(--dsw-alias-border-l2)'
const edgeKindKey = { 'uses-plan': 'usesPlan', 'informs-plan': 'informsPlan', 'revises-plan': 'revisesPlan' } as const
const card: CSSProperties = { background: 'var(--dsw-alias-bg-layer-3)', border, borderRadius: 10,
  boxShadow: '0 8px 28px rgba(0, 0, 0, 0.18)', padding: '14px 16px' }

function Pager({ page, count, title, onPage, t }: {
  page: number; count: number; title: string; onPage(page: number): void
} & Pick<ResearchViewProps, 't'>) {
  return <nav aria-label={title} style={row}>
    <Button variant="ghost" size="sm" aria-label={title + ': ' + t('previous')}
      disabled={page <= 0} onClick={() => onPage(page - 1)}>{t('previous')}</Button>
    <span style={muted}>{t('page', { page: page + 1, count })}</span>
    <Button variant="ghost" size="sm" aria-label={title + ': ' + t('next')}
      disabled={page + 1 >= count} onClick={() => onPage(page + 1)}>{t('next')}</Button>
  </nav>
}
function NodeFacts({ node, t }: { node: ResearchViewNode } & Pick<ResearchViewProps, 't'>) {
  return <div style={row}>
    <Tag>{t('revision', { revision: node.revision })}</Tag>
    {node.kind === 'plan' && node.selected && <Tag tone="info">{t('selected')}</Tag>}
    {node.kind === 'run' && <>
      <Tag tone={node.status === 'failed' ? 'danger' : node.status === 'completed' ? 'success' : 'neutral'}>
        {t(`run.${node.status}`)}
      </Tag>
      {node.pendingState && <Tag tone="warning">{t('pendingState')}</Tag>}
    </>}
  </div>
}

export function ResearchView(props: ResearchViewProps) {
  const { t, actions, renderSlot, enter, leave, load, inspectNode, listTargets, loadTarget } = props
  const state = props.useResearchView(value => value)
  const theme = props.useResearchTheme(value => value.active.colorScheme)
  const locale = props.useResearchLocale(value => value.active.startsWith('zh') ? 'zh-CN' as const : 'en' as const)
  const selection = props.useStore(value => value.selection)
  const selectedId = props.useStore(value => value.selectedNodeId)
  const snapshot = state.snapshot
  const [edgeSelection, setEdgeSelection] = useState<{ snapshotId: string; id: string } | null>(null)
  const descriptionRef = useRef<HTMLDivElement>(null)
  const markdownLabels = useMemo(() => ({ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }), [t, locale])
  const nodeTitle = (node: ResearchViewNode) => node.kind === 'run' ? t('experiment', { name: node.title }) : node.title
  const pageKey = viewPageKey(snapshot?.selection ?? selection)
  const camera = props.useStore(value => value.cameras[pageKey] ?? null)
  useEffect(() => { void enter(selection, { theme, locale }); return leave }, [enter, leave])
  useEffect(() => { void load(selection, { theme, locale }) }, [load, selection, theme, locale])
  useEffect(() => { void inspectNode(selectedId) }, [inspectNode, selectedId, snapshot?.snapshotId])
  useEffect(() => {
    if (props.viewRequest == null || snapshot === null || state.phase !== 'ready') return
    const node = snapshot.nodes.find(item => item.id === props.viewRequest?.focus)
    if (node !== undefined) actions.selectNode(node.id)
    props.completeViewRequest()
  }, [props.viewRequest, props.completeViewRequest, snapshot, state.phase, actions])
  useEffect(() => { setEdgeSelection(null) }, [snapshot?.snapshotId, pageKey])
  const selected = snapshot?.nodes.find(node => node.id === selectedId)
  const selectedEdge = edgeSelection?.snapshotId === snapshot?.snapshotId
    ? snapshot?.edges.find(edge => edge.id === edgeSelection?.id && edge.label.trim() !== '') : undefined
  const chooseEdge = (id: string) => {
    const edge = snapshot?.edges.find(item => item.id === id && item.label.trim() !== '')
    if (snapshot !== null && edge !== undefined) setEdgeSelection({ snapshotId: snapshot.snapshotId, id: edge.id })
  }
  const chooseNode = (id: string) => {
    const node = snapshot?.nodes.find(item => item.id === id)
    if (node !== undefined) { setEdgeSelection(null); actions.selectNode(node.id) }
  }
  const artifact = state.artifactAppearance?.theme === theme && state.artifactAppearance.locale === locale
    ? state.artifact : null
  // Move keyboard focus out of the sandboxed iframe so Escape reaches the dialog.
  useEffect(() => { if (selectedEdge !== undefined) descriptionRef.current?.focus() }, [selectedEdge, artifact])
  const live = state.watchError === null
  return <section aria-label={t('title')} style={{ display: 'flex', flexDirection: 'column',
    height: '100%', minHeight: 0, color: 'var(--dsw-alias-label-primary)' }}>
    <header style={{ ...row, flexWrap: 'nowrap', padding: '0 16px', height: 48, flex: 'none', borderBottom: border }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ ...muted, fontSize: 11, lineHeight: 1.2 }}>{t('target')}</div>
        <strong style={{ display: 'block', fontSize: 14, lineHeight: 1.3,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {snapshot?.goal.goal ?? t('title')}
        </strong>
      </div>
      {snapshot !== null && <Tag>{t(`state.${snapshot.state.status}`)}</Tag>}
      <Button variant="ghost" size="sm" disabled={live}
        aria-label={live ? t('live') : t('liveRetry')}
        onClick={() => { void load(selection, { theme, locale }, true) }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', flex: 'none',
          background: live ? '#16a34a' : '#9ca3af' }} />
        {live ? t('live') : t('liveRetry')}
      </Button>
      <Button variant="outline" size="sm" onClick={() => { void load(selection, { theme, locale }, true) }}>
        {t('refresh')}
      </Button>
    </header>
    {state.error !== null && <div role="alert" style={{ padding: '8px 16px' }}>
      <strong>{t('error')}</strong><pre style={code}>{state.error}</pre>
    </div>}
    {(state.phase === 'idle' || state.phase === 'loading') && <div role="status" style={{ padding: '8px 16px' }}>{t('loading')}</div>}
    {state.phase === 'unbound' && <div style={panel}>
      <p>{t('unbound')}</p><p style={muted}>{t('loadHint')}</p>
      <Button onClick={() => { void listTargets() }} disabled={state.targetsLoading}>{t('loadTarget')}</Button>
      {state.targetsLoading && <p role="status">{t('loading')}</p>}
      {state.targets !== null && <div style={{ ...stack, marginTop: 16 }}>
        {state.targets.targets.length === 0 && <p>{t('noTargets')}</p>}
        {state.targets.targets.map(target => <Button key={target.id} variant="outline"
          disabled={state.targetsLoading} onClick={() => { void loadTarget(target.id) }}>
          {target.description}
        </Button>)}
        {state.targets.invalid.map(target => <div key={target.id}>
          <strong>{t('invalidTarget', { id: target.id })}</strong><pre style={code}>{target.detail}</pre>
        </div>)}
      </div>}
    </div>}
    {snapshot !== null && <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ ...row, flex: 'none', padding: '6px 12px', borderBottom: border }}>
        <select aria-label={t('planSelect')} value={snapshot.selection.planId ?? ''}
          onChange={event => actions.selectPlan(Number(event.target.value))}
          style={{ fontSize: 12, padding: '4px 8px', border, borderRadius: 6, maxWidth: 280,
            background: 'transparent', color: 'inherit', textOverflow: 'ellipsis' }}>
          {snapshot.groups.map(group => <option key={group.planId} value={group.planId}>
            {t('plan', { id: group.planId }) + ' · ' + group.title}
          </option>)}
        </select>
        {snapshot.nodes.filter(node => node.kind === 'plan').map(node => {
          const count = Math.max(1, Math.ceil((snapshot.pages.runCounts[String(node.revision)] ?? 0) / snapshot.pages.runsPerVersionPage))
          if (count <= 1) return null
          return <div key={node.id} style={row}>
            <Tag>{t('revision', { revision: node.revision })}</Tag>
            <Pager t={t} page={snapshot.selection.runPages[String(node.revision)] ?? 0} count={count}
              title={t('runPages', { revision: node.revision })}
              onPage={page => actions.selectPage({ ...snapshot.selection,
                runPages: { ...snapshot.selection.runPages, [node.revision]: page } })} />
          </div>
        })}
      </div>
      <main aria-label={t('diagram')} style={{ position: 'relative', flex: 1, minHeight: 0,
        display: 'flex', flexDirection: 'column' }}>
        {state.rendering && <p role="status" style={panel}>{t('rendering')}</p>}
        {snapshot.nodes.length === 0 && <p style={panel}>{t('empty')}</p>}
        {artifact !== null && <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
          {renderSlot('research.view.diagram', {
            artifact: { ...artifact, edgeIds: snapshot.edges.filter(edge => edge.label.trim() !== '').map(edge => edge.id) },
            onEdgeSelect: chooseEdge,
            theme, locale, selectedNodeId: selected?.id ?? null, onNodeSelect: chooseNode,
            camera, onCameraChange: next => actions.setCamera(pageKey, next),
            labels: { title: t('diagram'), fit: t('fit'), downloadSvg: t('downloadSvg'), unavailable: t('unavailable') },
          })}
        </div>}
        {selected === undefined && artifact !== null && <span style={{ ...muted, position: 'absolute',
          left: 12, bottom: 10, pointerEvents: 'none' }}>{t('chooseNode')}</span>}
        {selected !== undefined && <div role="dialog" aria-label={nodeTitle(selected)} style={{ ...card,
          position: 'absolute', top: 12, right: 12, width: 340, maxWidth: 'calc(100% - 24px)',
          maxHeight: 'calc(100% - 24px)', overflow: 'auto', zIndex: 10, fontSize: 13 }}>
          <Button variant="ghost" size="sm" aria-label={t('close')}
            style={{ position: 'absolute', top: 6, right: 6 }}
            onClick={() => actions.selectNode(null)}>×</Button>
          <h4 style={{ margin: '0 0 8px', paddingRight: 20, lineHeight: 1.4, overflowWrap: 'anywhere' }}>{nodeTitle(selected)}</h4>
          <NodeFacts node={selected} t={t} />
          <p style={{ ...muted, overflowWrap: 'anywhere', lineHeight: 1.55, margin: '8px 0 10px' }}>{selected.summary}</p>
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', margin: '0 0 10px' }}>
            <dt style={muted}>{t('createdAt')}</dt><dd style={{ ...code, margin: 0 }}>{selected.createdAt}</dd>
            {selected.kind === 'plan' && <><dt style={muted}>{t('path')}</dt><dd style={{ ...code, margin: 0 }}>{selected.path}</dd></>}
            {selected.kind === 'plan' && <><dt style={muted}>{t('hash')}</dt><dd style={{ ...code, margin: 0 }}>{selected.sha256}</dd></>}
          </dl>
          {selected.kind === 'run' && <><h4>{t('metrics')}</h4><pre style={code}>{JSON.stringify(selected.metrics, null, 2)}</pre></>}
          {state.detailLoading && <p role="status">{t('loading')}</p>}
          {state.detail !== null && state.detail.node.id === selected.id && <details>
            <summary>{t('record')}</summary>
            <pre style={code}>{state.detail.kind === 'plan' ? state.detail.document.body : JSON.stringify(state.detail.record, null, 2)}</pre>
          </details>}
          {(snapshot.outsideLinks.length > 0 || snapshot.edges.some(edge => edge.from === selected.id || edge.to === selected.id)) && <>
            <h4>{t('provenance')}</h4><div style={stack}>
              {snapshot.edges.filter(edge => edge.from === selected.id || edge.to === selected.id).map(edge => {
                const other = edge.from === selected.id ? edge.to : edge.from
                const node = snapshot.nodes.find(item => item.id === other)
                return node === undefined ? null : <div key={edge.id} style={stack}>
                  <Button variant="ghost" onClick={() => chooseNode(node.id)}>
                    {t(edgeKindKey[edge.kind]) + ': ' + nodeTitle(node)}
                  </Button>
                  {edge.label.trim() !== '' && <Button variant="outline" size="sm" onClick={() => chooseEdge(edge.id)}>
                    {t('edgeDescription')}
                  </Button>}
                </div>
              })}
              {snapshot.outsideLinks.map(link => <Button key={link.edge.id} variant="outline"
                onClick={() => actions.selectPage(link.selection, link.nodeId)}>
                {t('outside') + ' · ' + t(edgeKindKey[link.edge.kind])}
              </Button>)}
            </div>
          </>}
        </div>}
        {snapshot.diagnostics.length > 0 && <details style={{ ...card, position: 'absolute',
          right: 12, bottom: 12, width: 340, maxWidth: 'calc(100% - 24px)', zIndex: 9 }}>
          <summary>{t('diagnostics')} ({snapshot.diagnostics.length})</summary>
          {snapshot.diagnostics.map((item, i) => <pre key={i} style={code}>{[item.code, item.message, item.path].filter(Boolean).join('\n')}</pre>)}
        </details>}
      </main>
    </div>}
    <Modal open={selectedEdge !== undefined && state.phase === 'ready' && artifact !== null}
      title={t('edgeDescription')} closeLabel={t('close')} onClose={() => setEdgeSelection(null)}>
      {selectedEdge !== undefined && <div ref={descriptionRef} tabIndex={-1} style={{ outline: 'none' }}>
        <p style={{ ...muted, overflowWrap: 'anywhere' }}>{t(edgeKindKey[selectedEdge.kind])}</p>
        <p style={{ fontSize: 13, overflowWrap: 'anywhere' }}>
          {[selectedEdge.from, selectedEdge.to].map(id => {
            const node = snapshot?.nodes.find(item => item.id === id)
            return node === undefined ? '' : node.kind === 'plan' ? t('revision', { revision: node.revision }) + ' · ' + node.title : nodeTitle(node)
          }).join(' → ')}
        </p>
        <div style={{ maxHeight: '60vh', overflow: 'auto', overflowWrap: 'anywhere' }}>
          <MarkdownText text={selectedEdge.label} labels={markdownLabels} />
        </div>
      </div>}
    </Modal>
  </section>
}
