import { viewExcerpt } from "./view-projection.js";
const labels = {
    en: { plan: 'Plan', selected: 'Selected', experiment: 'Experiment', unsealed: 'Unsealed', completed: 'Completed', failed: 'Failed', pending: 'State pending', research: 'Research' },
    'zh-CN': { plan: '方案', selected: '已选定', experiment: '实验', unsealed: '未封存', completed: '已完成', failed: '执行失败', pending: '待发布状态', research: '研究' },
};
// Three atomic plan/Run pairs per row; overflow stays in the same graph.
const COLUMNS_PER_ROW = 6;
const rowId = (row) => row === 0 ? 'research' : 'research_' + row;
/** Keep the fixed-width card legible; full authored names remain in node details. */
function experimentLabel(prefix, title) {
    const chars = Array.from((prefix + ' ' + title).replace(/\s+/gu, ' ').trim());
    const units = (char) => /[^\u0020-\u007e]/u.test(char) ? 2 : 1;
    if (chars.reduce((sum, char) => sum + units(char), 0) <= 21)
        return chars.join('');
    let label = '';
    let width = 0;
    for (const char of chars) {
        if (width + units(char) > 19)
            break;
        label += char;
        width += units(char);
    }
    return label.trimEnd() + '…';
}
/** Wrap logical plan/Run columns into six-column lanes with separate experiment slots. */
export function researchWorkflow(snapshot, locale) {
    const text = labels[locale];
    const active = snapshot.groups.find(group => group.planId === snapshot.selection.planId);
    const rows = [...new Set(snapshot.nodes.map(node => Math.floor(node.column / COLUMNS_PER_ROW)))].sort((a, b) => a - b);
    if (rows.length === 0)
        rows.push(0);
    return {
        schema_version: 2, diagram_type: 'workflow',
        meta: { title: viewExcerpt(active?.title ?? snapshot.goal.goal, 40), locale, quality_profile: 'standard', legend: { mode: 'hidden' }, subtitle: viewExcerpt(snapshot.goal.goal, 70) },
        lanes: rows.map(row => ({ id: rowId(row), label: rows.length === 1 ? text.research : text.research + ' · ' + (row + 1) })),
        nodes: snapshot.nodes.map(node => ({
            id: node.id, lane: rowId(Math.floor(node.column / COLUMNS_PER_ROW)), col: node.column % COLUMNS_PER_ROW, type: node.kind === 'plan' ? 'backend' : 'database', width: 140, height: 80,
            yOffset: -168 + node.slot * 112,
            label: node.kind === 'plan' ? text.plan + ' v' + node.revision : experimentLabel(text.experiment, node.title),
            sublabel: node.kind === 'plan' ? viewExcerpt(node.title, 8) : (node.pendingState ? text.pending : text[node.status]),
            tag: node.kind === 'plan' ? (node.selected ? text.selected : 'v' + node.revision) : (node.pendingState ? text.pending : text[node.status]),
        })),
        edges: snapshot.edges.map(edge => ({
            id: edge.id, from: edge.from, to: edge.to,
            /* Evidence links stay emphasized; discussion-driven revision lineage is dashed. */
            ...(edge.kind === 'uses-plan' ? {} : { label: viewExcerpt(edge.label, 8), variant: edge.kind === 'informs-plan' ? 'emphasis' : 'dashed' }),
        })),
    };
}
//# sourceMappingURL=view-workflow.js.map