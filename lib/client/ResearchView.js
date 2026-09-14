import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/** Props-only research browser. The Native plugin owns the sole diagram iframe. */
import { useEffect } from 'react';
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import { viewPageKey } from "./view-controller.js";
const panel = { padding: 16, overflow: 'auto', minHeight: 0, minWidth: 0 };
const row = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 };
const stack = { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 8 };
const code = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 };
const muted = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 };
const border = '1px solid var(--dsw-alias-border-l2)';
const edgeKindKey = { 'uses-plan': 'usesPlan', 'informs-plan': 'informsPlan', 'revises-plan': 'revisesPlan' };
const card = { background: 'var(--dsw-alias-bg-layer-3)', border, borderRadius: 10,
    boxShadow: '0 8px 28px rgba(0, 0, 0, 0.18)', padding: '14px 16px' };
function Pager({ page, count, title, onPage, t }) {
    return _jsxs("nav", { "aria-label": title, style: row, children: [_jsx(Button, { variant: "ghost", size: "sm", "aria-label": title + ': ' + t('previous'), disabled: page <= 0, onClick: () => onPage(page - 1), children: t('previous') }), _jsx("span", { style: muted, children: t('page', { page: page + 1, count }) }), _jsx(Button, { variant: "ghost", size: "sm", "aria-label": title + ': ' + t('next'), disabled: page + 1 >= count, onClick: () => onPage(page + 1), children: t('next') })] });
}
function NodeFacts({ node, t }) {
    return _jsxs("div", { style: row, children: [_jsx(Tag, { children: t('revision', { revision: node.revision }) }), node.kind === 'plan' && node.selected && _jsx(Tag, { tone: "info", children: t('selected') }), node.kind === 'run' && _jsxs(_Fragment, { children: [_jsx(Tag, { tone: node.status === 'failed' ? 'danger' : node.status === 'completed' ? 'success' : 'neutral', children: t(`run.${node.status}`) }), node.pendingState && _jsx(Tag, { tone: "warning", children: t('pendingState') })] })] });
}
export function ResearchView(props) {
    const { t, actions, renderSlot, enter, leave, load, inspectNode, listTargets, loadTarget } = props;
    const state = props.useResearchView(value => value);
    const theme = props.useResearchTheme(value => value.active.colorScheme);
    const locale = props.useResearchLocale(value => value.active.startsWith('zh') ? 'zh-CN' : 'en');
    const selection = props.useStore(value => value.selection);
    const selectedId = props.useStore(value => value.selectedNodeId);
    const snapshot = state.snapshot;
    const pageKey = viewPageKey(snapshot?.selection ?? selection);
    const camera = props.useStore(value => value.cameras[pageKey] ?? null);
    useEffect(() => { void enter(selection, { theme, locale }); return leave; }, [enter, leave]);
    useEffect(() => { void load(selection, { theme, locale }); }, [load, selection, theme, locale]);
    useEffect(() => { void inspectNode(selectedId); }, [inspectNode, selectedId, snapshot?.snapshotId]);
    useEffect(() => {
        if (props.viewRequest == null || snapshot === null || state.phase !== 'ready')
            return;
        const node = snapshot.nodes.find(item => item.id === props.viewRequest?.focus);
        if (node !== undefined)
            actions.selectNode(node.id);
        props.completeViewRequest();
    }, [props.viewRequest, props.completeViewRequest, snapshot, state.phase, actions]);
    const selected = snapshot?.nodes.find(node => node.id === selectedId);
    const chooseNode = (id) => {
        const node = snapshot?.nodes.find(item => item.id === id);
        if (node !== undefined)
            actions.selectNode(node.id);
    };
    const artifact = state.artifactAppearance?.theme === theme && state.artifactAppearance.locale === locale
        ? state.artifact : null;
    const live = state.watchError === null;
    return _jsxs("section", { "aria-label": t('title'), style: { display: 'flex', flexDirection: 'column',
            height: '100%', minHeight: 0, color: 'var(--dsw-alias-label-primary)' }, children: [_jsxs("header", { style: { ...row, flexWrap: 'nowrap', padding: '0 16px', height: 48, flex: 'none', borderBottom: border }, children: [_jsxs("div", { style: { flex: 1, minWidth: 0 }, children: [_jsx("div", { style: { ...muted, fontSize: 11, lineHeight: 1.2 }, children: t('target') }), _jsx("strong", { style: { display: 'block', fontSize: 14, lineHeight: 1.3,
                                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, children: snapshot?.goal.goal ?? t('title') })] }), snapshot !== null && _jsx(Tag, { children: t(`state.${snapshot.state.status}`) }), _jsxs(Button, { variant: "ghost", size: "sm", disabled: live, "aria-label": live ? t('live') : t('liveRetry'), onClick: () => { void load(selection, { theme, locale }, true); }, children: [_jsx("span", { style: { width: 7, height: 7, borderRadius: '50%', flex: 'none',
                                    background: live ? '#16a34a' : '#9ca3af' } }), live ? t('live') : t('liveRetry')] }), _jsx(Button, { variant: "outline", size: "sm", onClick: () => { void load(selection, { theme, locale }, true); }, children: t('refresh') })] }), state.error !== null && _jsxs("div", { role: "alert", style: { padding: '8px 16px' }, children: [_jsx("strong", { children: t('error') }), _jsx("pre", { style: code, children: state.error })] }), (state.phase === 'idle' || state.phase === 'loading') && _jsx("div", { role: "status", style: { padding: '8px 16px' }, children: t('loading') }), state.phase === 'unbound' && _jsxs("div", { style: panel, children: [_jsx("p", { children: t('unbound') }), _jsx("p", { style: muted, children: t('loadHint') }), _jsx(Button, { onClick: () => { void listTargets(); }, disabled: state.targetsLoading, children: t('loadTarget') }), state.targetsLoading && _jsx("p", { role: "status", children: t('loading') }), state.targets !== null && _jsxs("div", { style: { ...stack, marginTop: 16 }, children: [state.targets.targets.length === 0 && _jsx("p", { children: t('noTargets') }), state.targets.targets.map(target => _jsx(Button, { variant: "outline", disabled: state.targetsLoading, onClick: () => { void loadTarget(target.id); }, children: target.description }, target.id)), state.targets.invalid.map(target => _jsxs("div", { children: [_jsx("strong", { children: t('invalidTarget', { id: target.id }) }), _jsx("pre", { style: code, children: target.detail })] }, target.id))] })] }), snapshot !== null && _jsxs("div", { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }, children: [_jsxs("div", { style: { ...row, flex: 'none', padding: '6px 12px', borderBottom: border }, children: [_jsx("select", { "aria-label": t('planSelect'), value: snapshot.selection.planId ?? '', onChange: event => actions.selectPlan(Number(event.target.value)), style: { fontSize: 12, padding: '4px 8px', border, borderRadius: 6, maxWidth: 280,
                                    background: 'transparent', color: 'inherit', textOverflow: 'ellipsis' }, children: snapshot.groups.map(group => _jsx("option", { value: group.planId, children: t('plan', { id: group.planId }) + ' · ' + group.title }, group.planId)) }), _jsx(Pager, { t: t, page: snapshot.selection.versionPage, count: snapshot.pages.versionPages, title: t('versionPages'), onPage: versionPage => actions.selectPage({ ...snapshot.selection, versionPage, runPages: {} }) }), snapshot.nodes.filter(node => node.kind === 'plan').map(node => {
                                const count = Math.max(1, Math.ceil((snapshot.pages.runCounts[String(node.revision)] ?? 0) / snapshot.pages.runsPerVersionPage));
                                if (count <= 1)
                                    return null;
                                return _jsxs("div", { style: row, children: [_jsx(Tag, { children: t('revision', { revision: node.revision }) }), _jsx(Pager, { t: t, page: snapshot.selection.runPages[String(node.revision)] ?? 0, count: count, title: t('runPages', { revision: node.revision }), onPage: page => actions.selectPage({ ...snapshot.selection,
                                                runPages: { ...snapshot.selection.runPages, [node.revision]: page } }) })] }, node.id);
                            })] }), _jsxs("main", { "aria-label": t('diagram'), style: { position: 'relative', flex: 1, minHeight: 0,
                            display: 'flex', flexDirection: 'column' }, children: [state.rendering && _jsx("p", { role: "status", style: panel, children: t('rendering') }), snapshot.nodes.length === 0 && _jsx("p", { style: panel, children: t('empty') }), artifact !== null && _jsx("div", { style: { flex: 1, minHeight: 360 }, children: renderSlot('research.view.diagram', {
                                    artifact,
                                    theme, locale, selectedNodeId: selected?.id ?? null, onNodeSelect: chooseNode,
                                    camera, onCameraChange: next => actions.setCamera(pageKey, next),
                                    labels: { title: t('diagram'), fit: t('fit'), downloadSvg: t('downloadSvg'), unavailable: t('unavailable') },
                                }) }), selected === undefined && artifact !== null && _jsx("span", { style: { ...muted, position: 'absolute',
                                    left: 12, bottom: 10, pointerEvents: 'none' }, children: t('chooseNode') }), selected !== undefined && _jsxs("div", { role: "dialog", "aria-label": selected.title, style: { ...card,
                                    position: 'absolute', top: 12, right: 12, width: 340, maxWidth: 'calc(100% - 24px)',
                                    maxHeight: 'calc(100% - 24px)', overflow: 'auto', zIndex: 10, fontSize: 13 }, children: [_jsx(Button, { variant: "ghost", size: "sm", "aria-label": t('close'), style: { position: 'absolute', top: 6, right: 6 }, onClick: () => actions.selectNode(null), children: "\u00D7" }), _jsx("h4", { style: { margin: '0 0 8px', paddingRight: 20, lineHeight: 1.4 }, children: selected.title }), _jsx(NodeFacts, { node: selected, t: t }), _jsx("p", { style: { ...muted, overflowWrap: 'anywhere', lineHeight: 1.55, margin: '8px 0 10px' }, children: selected.summary }), _jsxs("dl", { style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', margin: '0 0 10px' }, children: [_jsx("dt", { style: muted, children: t('createdAt') }), _jsx("dd", { style: { ...code, margin: 0 }, children: selected.createdAt }), _jsx("dt", { style: muted, children: t('path') }), _jsx("dd", { style: { ...code, margin: 0 }, children: selected.path }), selected.kind === 'plan' && _jsxs(_Fragment, { children: [_jsx("dt", { style: muted, children: t('hash') }), _jsx("dd", { style: { ...code, margin: 0 }, children: selected.sha256 })] })] }), selected.kind === 'run' && _jsxs(_Fragment, { children: [_jsx("h4", { children: t('metrics') }), _jsx("pre", { style: code, children: JSON.stringify(selected.metrics, null, 2) })] }), state.detailLoading && _jsx("p", { role: "status", children: t('loading') }), state.detail !== null && state.detail.node.id === selected.id && _jsxs("details", { open: true, children: [_jsx("summary", { children: t('record') }), _jsx("pre", { style: code, children: state.detail.kind === 'plan' ? state.detail.document.body : JSON.stringify(state.detail.record, null, 2) })] }), (snapshot.outsideLinks.length > 0 || snapshot.edges.some(edge => edge.from === selected.id || edge.to === selected.id)) && _jsxs(_Fragment, { children: [_jsx("h4", { children: t('provenance') }), _jsxs("div", { style: stack, children: [snapshot.edges.filter(edge => edge.from === selected.id || edge.to === selected.id).map(edge => {
                                                        const other = edge.from === selected.id ? edge.to : edge.from;
                                                        const node = snapshot.nodes.find(item => item.id === other);
                                                        return node === undefined ? null : _jsx(Button, { variant: "ghost", onClick: () => chooseNode(node.id), children: t(edgeKindKey[edge.kind]) + ': ' + node.title }, edge.id);
                                                    }), snapshot.outsideLinks.map(link => _jsx(Button, { variant: "outline", onClick: () => actions.selectPage(link.selection, link.nodeId), children: t('outside') + ' · ' + t(edgeKindKey[link.edge.kind]) }, link.edge.id))] })] })] }), snapshot.diagnostics.length > 0 && _jsxs("details", { style: { ...card, position: 'absolute',
                                    right: 12, bottom: 12, width: 340, maxWidth: 'calc(100% - 24px)', zIndex: 9 }, children: [_jsxs("summary", { children: [t('diagnostics'), " (", snapshot.diagnostics.length, ")"] }), snapshot.diagnostics.map((item, i) => _jsx("pre", { style: code, children: [item.code, item.message, item.path].filter(Boolean).join('\n') }, i))] })] })] })] });
}
//# sourceMappingURL=ResearchView.js.map