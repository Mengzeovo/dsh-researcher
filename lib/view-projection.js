/** Continuous plan graphs with bounded Run rows over verified research records. */
import { createHash } from 'node:crypto';
import { ResearcherError } from "./errors.js";
export function planNodeId(planId, revision) { return ('plan_' + planId + '_v' + revision); }
export function runNodeId(runId) { return ('run_' + runId); }
/** Summaries preserve authored content; they are not model-generated paraphrases. */
export function viewExcerpt(value, length) {
    const units = Array.from(value.replace(/\s+/gu, ' ').trim());
    return units.length <= length ? units.join('') : units.slice(0, length - 1).join('') + '…';
}
function versionKey(planId, revision) { return planId + ':' + revision; }
/** Input records already passed file/schema checks; this function verifies their cross-references. */
export function projectResearchView(data, targetToken, request, config) {
    const diagnostics = [...data.diagnostics];
    const plans = [...data.plans].sort((a, b) => a.document.metadata.plan_id - b.document.metadata.plan_id || a.document.metadata.revision - b.document.metadata.revision);
    const byVersion = new Map(plans.map(plan => [versionKey(plan.document.metadata.plan_id, plan.document.metadata.revision), plan]));
    const runsByVersion = new Map();
    const runsById = new Map();
    for (const record of [...data.runs].sort((a, b) => a.run.description.createdAt.localeCompare(b.run.description.createdAt) || a.run.id.localeCompare(b.run.id))) {
        const description = record.run.description;
        if (description.version !== 3) {
            diagnostics.push({ code: 'RUN_WITHOUT_PLAN', message: 'This Run has no recorded plan reference.', path: record.path, nodeId: runNodeId(record.run.id) });
            continue;
        }
        const ref = description.planRef;
        const key = versionKey(ref.planId, ref.revision);
        if (byVersion.get(key)?.document.sha256 !== ref.sha256) {
            diagnostics.push({ code: 'RUN_PLAN_INTEGRITY', message: 'The Run plan reference does not match a verified version.', path: record.path, planId: ref.planId, nodeId: runNodeId(record.run.id) });
            continue;
        }
        const list = runsByVersion.get(key) ?? [];
        list.push(record);
        runsByVersion.set(key, list);
        runsById.set(record.run.id, record);
    }
    const allEdges = [];
    for (const record of plans) {
        const meta = record.document.metadata;
        const planId = planNodeId(meta.plan_id, meta.revision);
        for (const run of runsByVersion.get(versionKey(meta.plan_id, meta.revision)) ?? []) {
            allEdges.push({ id: 'uses_' + run.run.id, kind: 'uses-plan', from: planId, to: runNodeId(run.run.id), label: '' });
        }
        /* A revision declaring no experiment evidence has no recorded experiment basis: draw one
           direct lineage edge from the previous committed revision, labeled with its authored
           change notes. Evidence-bearing revisions never carry both edge kinds, and a missing
           predecessor record cannot invent lineage. */
        const declared = meta.schema_version === 2 ? meta.based_on_runs : [];
        if (meta.revision > 1 && declared.length === 0 && byVersion.has(versionKey(meta.plan_id, meta.revision - 1))) {
            allEdges.push({ id: 'revises_' + meta.plan_id + '_v' + meta.revision, kind: 'revises-plan', from: planNodeId(meta.plan_id, meta.revision - 1), to: planId, label: meta.delta.join(' · ') });
        }
        if (meta.schema_version !== 2)
            continue;
        for (const evidence of meta.based_on_runs) {
            const basis = runsById.get(evidence.run_id);
            const description = basis?.run.description;
            if (basis === undefined || !basis.committed || basis.sha256 !== evidence.sha256 || description?.version !== 3 || description.planRef.planId !== meta.plan_id || description.planRef.revision >= meta.revision) {
                diagnostics.push({ code: 'PLAN_EVIDENCE_INTEGRITY', message: 'The declared experiment basis cannot be verified.', path: record.path, planId: meta.plan_id, nodeId: planId });
                continue;
            }
            allEdges.push({ id: 'basis_' + evidence.run_id + '_v' + meta.revision, kind: 'informs-plan', from: runNodeId(evidence.run_id), to: planId, label: evidence.reason });
        }
    }
    const groupsById = new Map(data.planDirectories.map(planId => [planId, { planId, title: '#' + planId, latestRevision: 0, revisionCount: 0, runCount: 0, warningCount: 0 }]));
    for (const record of plans) {
        const metadata = record.document.metadata;
        const prior = groupsById.get(metadata.plan_id);
        groupsById.set(metadata.plan_id, {
            planId: metadata.plan_id, title: prior !== undefined && prior.revisionCount > 0 ? prior.title : metadata.title, latestRevision: metadata.revision,
            revisionCount: (prior?.revisionCount ?? 0) + 1,
            runCount: (prior?.runCount ?? 0) + (runsByVersion.get(versionKey(metadata.plan_id, metadata.revision))?.length ?? 0),
            warningCount: 0,
        });
    }
    for (const diagnostic of diagnostics) {
        if (diagnostic.planId === undefined)
            continue;
        const group = groupsById.get(diagnostic.planId);
        if (group !== undefined)
            groupsById.set(diagnostic.planId, { ...group, warningCount: group.warningCount + 1 });
    }
    const selected = data.state.selectedPlanRef;
    if (selected !== undefined && byVersion.get(versionKey(selected.planId, selected.revision))?.document.sha256 !== selected.sha256) {
        diagnostics.push({ code: 'SELECTED_PLAN_INTEGRITY', message: 'The selected plan version is missing or its digest differs.', planId: selected.planId });
        const group = groupsById.get(selected.planId);
        if (group !== undefined)
            groupsById.set(selected.planId, { ...group, warningCount: group.warningCount + 1 });
    }
    const groups = [...groupsById.values()].sort((a, b) => a.planId - b.planId);
    const selectedId = selected !== undefined && groupsById.has(selected.planId) ? selected.planId : undefined;
    const activeId = request.planId ?? selectedId ?? groups[0]?.planId ?? null;
    const activeGroup = activeId === null ? undefined : groupsById.get(activeId);
    if (activeId !== null && activeGroup === undefined)
        throw new ResearcherError('requested plan partition does not exist', 'RESEARCH_NOT_FOUND');
    const activePlans = plans.filter(record => record.document.metadata.plan_id === activeId);
    const nodes = [];
    const details = new Map();
    const runCounts = {};
    const runPages = {};
    const location = new Map();
    for (const plan of plans) {
        const meta = plan.document.metadata;
        const key = versionKey(meta.plan_id, meta.revision);
        const versionLocation = { planId: meta.plan_id, runPages: {} };
        location.set(planNodeId(meta.plan_id, meta.revision), versionLocation);
        const runs = runsByVersion.get(key) ?? [];
        runs.forEach((run, index) => location.set(runNodeId(run.run.id), { ...versionLocation, runPages: { [meta.revision]: Math.floor(index / config.runsPerVersionPage) } }));
    }
    for (const [index, plan] of activePlans.entries()) {
        const meta = plan.document.metadata;
        const id = planNodeId(meta.plan_id, meta.revision);
        // Compact verified revisions, even when damaged history leaves numeric gaps.
        const column = index * 2;
        const node = {
            id, kind: 'plan', planId: meta.plan_id, revision: meta.revision, title: meta.title, summary: viewExcerpt(meta.delta.join(' · '), 180),
            createdAt: meta.created_at, path: plan.path, column, slot: 0, sha256: plan.document.sha256,
            selected: selected?.planId === meta.plan_id && selected.revision === meta.revision && selected.sha256 === plan.document.sha256,
        };
        nodes.push(node);
        details.set(id, { kind: 'plan', node, document: plan.document });
        const runs = runsByVersion.get(versionKey(meta.plan_id, meta.revision)) ?? [];
        runCounts[meta.revision] = runs.length;
        const openIndex = runs.findIndex(value => value.run.result === undefined);
        const defaultRunPage = Math.floor(Math.max(0, openIndex === -1 ? runs.length - 1 : openIndex) / config.runsPerVersionPage);
        const runPage = request.runPages?.[meta.revision] ?? defaultRunPage;
        if (runPage >= Math.max(1, Math.ceil(runs.length / config.runsPerVersionPage)))
            throw new ResearcherError('requested experiment page does not exist', 'RESEARCH_VIEW_PAGE');
        runPages[meta.revision] = runPage;
        runs.slice(runPage * config.runsPerVersionPage, (runPage + 1) * config.runsPerVersionPage).forEach((record, slot) => {
            const run = record.run;
            const runId = runNodeId(run.id);
            const runNode = {
                id: runId, kind: 'run', planId: meta.plan_id, revision: meta.revision, runId: run.id,
                title: run.description.purpose, summary: viewExcerpt(run.result?.result ?? '', 180), path: record.path,
                createdAt: run.description.createdAt, column: column + 1, slot, status: run.result?.status ?? 'unsealed',
                pendingState: run.result !== undefined && !record.committed, metrics: run.result?.metrics ?? {},
            };
            nodes.push(runNode);
            details.set(runId, { kind: 'run', node: runNode, record: run });
        });
    }
    const visible = new Set(nodes.map(node => node.id));
    const edges = allEdges.filter(edge => visible.has(edge.from) && visible.has(edge.to));
    const outsideLinks = [];
    for (const edge of allEdges) {
        if (edge.kind === 'uses-plan' || visible.has(edge.from) === visible.has(edge.to))
            continue;
        const nodeId = visible.has(edge.from) ? edge.to : edge.from;
        outsideLinks.push({ edge, nodeId, selection: location.get(nodeId) });
    }
    const selection = { planId: activeId, runPages };
    const snapshotId = createHash('sha256').update(JSON.stringify({ format: 3, targetToken, records: data.recordVersion, selection, runsPerVersionPage: config.runsPerVersionPage })).digest('hex');
    const snapshot = {
        kind: nodes.length === 0 ? 'empty' : 'ready', snapshotId, targetToken, researchId: data.researchId, goal: data.goal, state: data.state,
        groups, selection, pages: { runsPerVersionPage: config.runsPerVersionPage, runCounts },
        nodes, edges, outsideLinks, diagnostics,
    };
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > config.maxSnapshotBytes)
        throw new ResearcherError('research view exceeds the configured response byte limit', 'RESEARCH_OVERSIZED');
    return { snapshot, details };
}
//# sourceMappingURL=view-projection.js.map