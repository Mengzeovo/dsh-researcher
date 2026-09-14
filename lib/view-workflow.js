import { viewExcerpt } from "./view-projection.js";
const labels = {
    en: { plan: 'Plan', selected: 'Selected', experiment: 'Experiment', unsealed: 'Unsealed', completed: 'Completed', failed: 'Failed', pending: 'State pending', research: 'Research' },
    'zh-CN': { plan: '方案', selected: '已选定', experiment: '实验', unsealed: '未封存', completed: '已完成', failed: '执行失败', pending: '待发布状态', research: '研究' },
};
/** Fixed card geometry leaves separate slots for every experiment on the active page. */
export function researchWorkflow(snapshot, locale) {
    const text = labels[locale];
    const active = snapshot.groups.find(group => group.planId === snapshot.selection.planId);
    return {
        schema_version: 2, diagram_type: 'workflow',
        meta: { title: viewExcerpt(active?.title ?? snapshot.goal.goal, 40), locale, quality_profile: 'standard', legend: { mode: 'hidden' }, subtitle: viewExcerpt(snapshot.goal.goal, 70) },
        lanes: [{ id: 'research', label: text.research }],
        nodes: snapshot.nodes.map(node => ({
            id: node.id, lane: 'research', col: node.column, type: node.kind === 'plan' ? 'backend' : 'database', width: 140, height: 80,
            yOffset: -168 + node.slot * 112,
            label: node.kind === 'plan' ? text.plan + ' v' + node.revision : 'R ' + node.runId.slice(0, 6),
            sublabel: viewExcerpt(node.title, 8),
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