import { defineTool } from '@deepseek-ai/dsh-tools';
import { requireDirectHuman, requireResearchMutation, researchToolExecution } from "./authority.js";
import { ResearcherError, invalidRecord } from "./errors.js";
import { parseRunId } from "./schema.js";
import { researchNotebookGuide } from "./notebook.js";
export const name = 'tool-researcher';
export const inject = ['agents', 'goals', 'researcher', 'sessionProjections', 'tools'];
const STATUS_VALUES = ['active', 'paused', 'blocked', 'complete'];
const RUN_STATUS_VALUES = ['completed', 'failed'];
const CHECKPOINT_OUTPUT = {
    type: 'object', additionalProperties: false,
    properties: {
        input_commit: { type: 'string', required: true },
        input_ref: { type: 'string', required: true },
        output_commit: { type: 'string' },
        output_ref: { type: 'string', required: true },
        code_changed: { type: 'boolean' },
        verification: { type: 'string', required: true },
        snapshot_mode: { type: 'string', enum: ['scoped-overlay'] },
        base_commit: { type: 'string' },
        captured_files: { type: 'integer' },
        deleted_files: { type: 'array', items: { type: 'string' } },
        omitted_changes: { type: 'array', items: { type: 'string' } },
    },
};
const PLAN_SELECTOR = {
    type: 'object', additionalProperties: false,
    properties: { plan_id: { type: 'integer', required: true }, revision: { type: 'integer', required: true } },
};
const PLAN_REF_OUTPUT = {
    ...PLAN_SELECTOR,
    properties: { ...PLAN_SELECTOR.properties, sha256: { type: 'string', required: true } },
};
const PLAN_RUN_BASIS = {
    type: 'object', additionalProperties: false,
    properties: {
        run_id: { type: 'string', required: true },
        reason: { type: 'string', required: true },
    },
};
const PLAN_OUTPUT = {
    type: 'object', additionalProperties: false,
    properties: {
        id: { type: 'string', required: true }, schema_version: { type: 'integer', required: true },
        plan_id: { type: 'integer', required: true }, revision: { type: 'integer', required: true },
        title: { type: 'string', required: true }, created_at: { type: 'string', required: true },
        delta: { type: 'array', required: true, items: { type: 'string' } },
        based_on_runs: { type: 'array', items: { ...PLAN_RUN_BASIS, properties: { ...PLAN_RUN_BASIS.properties, sha256: { type: 'string', required: true } } } },
        body: { type: 'string', required: true }, markdown: { type: 'string', required: true },
        sha256: { type: 'string', required: true }, path: { type: 'string', required: true },
        latest_revision: { type: 'integer', required: true },
        warnings: { type: 'array', required: true, items: { type: 'string' } },
    },
};
const PLAN_CONTENT = {
    title: { type: 'string', required: true },
    body: { type: 'string', required: true, description: 'Complete nonblank Markdown body. Explain what/why/evaluation when useful. For important choices, explain the main tradeoffs and the basis for the chosen approach, referencing relevant evidence or sources when available. No prescribed headings or mandatory survey.' },
    delta: { type: 'array', required: true, items: { type: 'string' }, description: 'At least one nonblank change note; initial plans may say Initial proposal.' },
};
const RESEARCH_STATE_OUTPUT = {
    type: 'object',
    additionalProperties: false,
    properties: {
        revision: { type: 'integer', required: true },
        status: { type: 'string', required: true, enum: STATUS_VALUES },
        at: { type: 'string', required: true },
        summary: { type: 'string', required: true },
        direction: { type: 'string' },
        next: { type: 'string' },
        last_run_id: { type: 'string' },
        selected_plan: PLAN_REF_OUTPUT,
    },
};
function output(schema) {
    return {
        schema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    };
}
function present(title, kind, rawInput) {
    return { card: 'generic', title, kind, ...(rawInput === undefined ? {} : { rawInput }) };
}
function boundResearchId(ctx, execution) {
    const binding = ctx.researcher.binding(execution.agent.session);
    if (binding === undefined) {
        throw new ResearcherError('no research target is loaded; ask the human to use /research-load <research-id>', 'RESEARCH_NOT_FOUND');
    }
    return binding.researchId;
}
function planRefValue(ref) {
    return { plan_id: ref.planId, revision: ref.revision, sha256: ref.sha256 };
}
function planValue(value) {
    const metadata = value.plan.metadata;
    return { id: value.researchId, schema_version: metadata.schema_version, plan_id: metadata.plan_id,
        revision: metadata.revision, title: metadata.title, created_at: metadata.created_at, delta: [...metadata.delta],
        ...(metadata.schema_version === 2 ? { based_on_runs: metadata.based_on_runs.map(item => ({ ...item })) } : {}),
        body: value.plan.body, markdown: value.plan.markdown, sha256: value.plan.sha256,
        path: value.path, latest_revision: value.latestRevision, warnings: [...value.warnings] };
}
function stateValue(state) {
    return {
        revision: state.revision,
        status: state.status,
        at: state.at,
        summary: state.summary,
        ...(state.direction === undefined ? {} : { direction: state.direction }),
        ...(state.next === undefined ? {} : { next: state.next }),
        ...(state.lastRunId === undefined ? {} : { last_run_id: state.lastRunId }),
        ...(state.selectedPlanRef === undefined ? {} : { selected_plan: planRefValue(state.selectedPlanRef) }),
    };
}
function stringNullMap(subject, value) {
    if (value === undefined)
        return undefined;
    const mapped = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'string' && item !== null)
            invalidRecord(`${subject}.${key} must be a string or null`);
        mapped[key] = item;
    }
    return mapped;
}
export function apply(ctx) {
    ctx.tools.register(defineTool({
        name: 'research_notebook',
        description: 'Get the current research notebook location, format and usage guide. Call before using notes.',
        parameters: {},
        output: output({
            type: 'object', additionalProperties: false,
            properties: {
                notebook_path: { type: 'string', required: true },
                sources_path: { type: 'string', required: true },
                session_id: { type: 'string', required: true },
                instructions: { type: 'string', required: true },
            },
        }),
        async execute(_args, exec) {
            const execution = researchToolExecution(ctx, exec);
            boundResearchId(ctx, execution);
            const result = await ctx.researcher.get(execution.agent, exec.signal);
            return researchNotebookGuide(result.target.root, String(execution.agent.session.id));
        },
        isConcurrencySafe: () => true,
        presentCall: () => present('Read notebook usage guide', 'read'),
    }));
    ctx.tools.register(defineTool({
        name: 'create_research_plan',
        description: 'Create a first-class plan in the loaded research target: full Markdown plus Host-generated identity, revision, time and SHA-256. Survey is optional. This does not select the plan. If publication success is uncertain, list/get before creating again; do not directly edit authoritative files.',
        parameters: PLAN_CONTENT,
        output: output(PLAN_OUTPUT),
        async execute(args, exec) {
            const execution = researchToolExecution(ctx, exec);
            requireResearchMutation(ctx, execution, boundResearchId(ctx, execution));
            return planValue(await ctx.researcher.createPlan(execution.agent, args, exec.signal));
        },
        presentCall: args => present('Create research plan', 'other', args.title),
    }));
    ctx.tools.register(defineTool({
        name: 'update_research_plan',
        description: 'Append a complete immutable plan revision with delta notes. expected_revision is the latest committed revision, not the selected one. Optionally cite sealed experiments that informed this revision with based_on_runs; each must use an earlier version of this same plan with its result and state committed. Do not infer causal links from chronology. Evidence is not inherited when omitted. Identical explicit retries recover interrupted registration; stale/conflicting payloads never overwrite or rebase. Publishing does not change selection.',
        parameters: {
            plan_id: { type: 'integer', required: true }, expected_revision: { type: 'integer', required: true }, ...PLAN_CONTENT,
            based_on_runs: { type: 'array', items: PLAN_RUN_BASIS, description: 'Optional unique sealed Run references and nonblank reasons explaining how each informed this revision. The Host pins their content hashes; do not supply hashes. Omit when no experiment basis is declared.' },
        },
        output: output(PLAN_OUTPUT),
        async execute(args, exec) {
            const execution = researchToolExecution(ctx, exec);
            requireResearchMutation(ctx, execution, boundResearchId(ctx, execution));
            return planValue(await ctx.researcher.updatePlan(execution.agent, {
                planId: args.plan_id, expectedRevision: args.expected_revision, title: args.title, body: args.body, delta: args.delta,
                ...(args.based_on_runs === undefined ? {} : { basedOnRuns: args.based_on_runs.map(item => ({ runId: parseRunId(item.run_id), reason: item.reason })) }),
            }, exec.signal));
        },
        presentCall: args => present('Revise research plan ' + args.plan_id, 'other', args.delta),
    }));
    ctx.tools.register(defineTool({
        name: 'get_research_plan',
        description: 'Read and verify a plan snapshot in the loaded target. Omit revision only to read its latest committed version; selection and run binding always use an exact revision. Never repair a hash mismatch by rewriting its ledger.',
        parameters: { plan_id: { type: 'integer', required: true }, revision: { type: 'integer' } },
        output: output(PLAN_OUTPUT),
        async execute(args, exec) {
            const execution = researchToolExecution(ctx, exec);
            return planValue(await ctx.researcher.getPlan(execution.agent, { planId: args.plan_id, ...(args.revision === undefined ? {} : { revision: args.revision }) }, exec.signal));
        },
        isConcurrencySafe: () => true,
        presentCall: args => present('Read research plan ' + args.plan_id, 'read'),
    }));
    ctx.tools.register(defineTool({
        name: 'list_research_plans',
        description: 'List loaded-target plans by increasing numeric ID with latest committed metadata and separate invalid entries. Defaults to 50 items, maximum 100. Candidate publication is not selection; inspect the selected reference through get_research.',
        parameters: { after_id: { type: 'integer' }, limit: { type: 'integer' } },
        output: output({
            type: 'object', additionalProperties: false,
            properties: {
                id: { type: 'string', required: true }, next_after_id: { type: 'integer' },
                plans: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                            plan_id: { type: 'integer', required: true }, latest_revision: { type: 'integer', required: true },
                            title: { type: 'string', required: true }, created_at: { type: 'string', required: true },
                            sha256: { type: 'string', required: true }, path: { type: 'string', required: true },
                        } } },
                invalid: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                            plan_id: { type: 'integer', required: true }, code: { type: 'string', required: true }, detail: { type: 'string', required: true },
                        } } },
            },
        }),
        async execute(args, exec) {
            const execution = researchToolExecution(ctx, exec);
            const value = await ctx.researcher.listPlans(execution.agent, {
                ...(args.after_id === undefined ? {} : { afterId: args.after_id }), ...(args.limit === undefined ? {} : { limit: args.limit }),
            }, exec.signal);
            return { id: value.researchId,
                plans: value.plans.map(plan => ({ plan_id: plan.planId, latest_revision: plan.latestRevision, title: plan.title, created_at: plan.createdAt, sha256: plan.sha256, path: plan.path })),
                invalid: value.invalid.map(item => ({ plan_id: item.planId, code: item.code, detail: item.detail })),
                ...(value.nextAfterId === undefined ? {} : { next_after_id: value.nextAfterId }),
            };
        },
        isConcurrencySafe: () => true,
        presentCall: () => present('List research plans', 'read'),
    }));
    ctx.tools.register(defineTool({
        name: 'select_research_plan',
        description: 'Select an exact committed plan revision using the current research state revision. Preserve all other state fields; never auto-select a newer plan. Selection is blocked while any run is open or its state publication is pending. Does not activate a DSH Goal.',
        parameters: { plan_id: { type: 'integer', required: true }, revision: { type: 'integer', required: true }, expected_state_revision: { type: 'integer', required: true } },
        output: output({ type: 'object', additionalProperties: false, properties: {
                id: { type: 'string', required: true }, path: { type: 'string', required: true }, state: { ...RESEARCH_STATE_OUTPUT, required: true },
            } }),
        async execute(args, exec) {
            const execution = researchToolExecution(ctx, exec);
            requireResearchMutation(ctx, execution, boundResearchId(ctx, execution));
            const value = await ctx.researcher.selectPlan(execution.agent, { planId: args.plan_id, revision: args.revision, expectedStateRevision: args.expected_state_revision }, exec.signal);
            return { id: value.researchId, path: value.path, state: stateValue(value.state) };
        },
        presentCall: args => present('Select research plan ' + args.plan_id + ' v' + args.revision, 'other'),
    }));
    ctx.tools.register(defineTool({
        name: 'get_research',
        description: 'Read the currently loaded cross-session research target and its bounded authoritative snapshot. '
            + 'Recovery, when present, identifies an open run or a closed run whose state is pending. output_ref is planned, not proof of sealing; inspect its journal if present and reuse the exact original finish payload. '
            + 'There is no model load action; if none is loaded, ask the human to use /research-load.',
        parameters: {},
        output: output({
            type: 'object',
            additionalProperties: false,
            properties: {
                research: {
                    type: 'object',
                    required: true,
                    additionalProperties: false,
                    properties: {
                        id: { type: 'string', required: true },
                        root: { type: 'string', required: true },
                        goal_path: { type: 'string', required: true },
                        status: { type: 'string', required: true, enum: STATUS_VALUES },
                        revision: { type: 'integer', required: true },
                        updated_at: { type: 'string', required: true },
                        summary: { type: 'string', required: true },
                        direction: { type: 'string' },
                        next: { type: 'string' },
                        last_run_id: { type: 'string' },
                        selected_plan: PLAN_REF_OUTPUT,
                        selected_plan_path: { type: 'string' },
                        selected_plan_title: { type: 'string' },
                        recovery: {
                            type: 'object', additionalProperties: false,
                            properties: {
                                run_id: { type: 'string', required: true },
                                plan_ref: PLAN_REF_OUTPUT,
                                phase: { type: 'string', required: true, enum: ['open', 'pending-state'] },
                                path: { type: 'string', required: true },
                                output_ref: { type: 'string', description: 'Planned Git ref; read its commit-message journal if it exists. Not proof of sealing.' },
                            },
                        },
                        warnings: { type: 'array', required: true, items: { type: 'string' } },
                        context: { type: 'string', required: true },
                    },
                },
            },
        }),
        async execute(_args, exec) {
            const execution = researchToolExecution(ctx, exec);
            const result = await ctx.researcher.get(execution.agent, exec.signal);
            const state = result.target.state;
            const recovery = result.target.recovery;
            return {
                research: {
                    id: result.researchId,
                    root: result.target.root,
                    goal_path: result.target.goalPath,
                    status: state.status,
                    revision: state.revision,
                    updated_at: state.at,
                    summary: state.summary,
                    ...(state.direction === undefined ? {} : { direction: state.direction }),
                    ...(state.next === undefined ? {} : { next: state.next }),
                    ...(state.lastRunId === undefined ? {} : { last_run_id: state.lastRunId }),
                    ...(state.selectedPlanRef === undefined ? {} : { selected_plan: planRefValue(state.selectedPlanRef) }),
                    ...(result.target.selectedPlan === undefined ? {} : { selected_plan_path: result.target.selectedPlan.path, selected_plan_title: result.target.selectedPlan.title.slice(0, 500) }),
                    ...(recovery === undefined ? {} : { recovery: {
                            run_id: recovery.runId, phase: recovery.phase, path: recovery.path,
                            ...(recovery.planRef === undefined ? {} : { plan_ref: planRefValue(recovery.planRef) }),
                            ...(recovery.outputRef === undefined ? {} : { output_ref: recovery.outputRef }),
                        } }),
                    warnings: [...result.target.warnings],
                    context: result.context.text,
                },
            };
        },
        isConcurrencySafe: () => true,
        presentCall: () => present('Read research target', 'read'),
    }));
    ctx.tools.register(defineTool({
        name: 'create_research',
        description: 'Create one project-scoped cross-session research target from the current direct human request. '
            + 'This writes .research records, binds the session, injects context, and creates the matching DSH Goal. '
            + 'Do not call from a subagent or automatic Goal Round.',
        parameters: {
            goal: { type: 'string', required: true, description: 'Concrete research objective.' },
            metrics: { type: 'array', required: true, items: { type: 'string' }, description: 'Observable success criteria.' },
            baseline: { type: 'string', required: true, description: 'Current baseline or comparison point.' },
            direction: { type: 'string', description: 'Optional initial approach or direction.' },
            next: { type: 'string', description: 'Optional immediate next action.' },
        },
        output: output({
            type: 'object',
            additionalProperties: false,
            properties: {
                id: { type: 'string', required: true },
                root: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: STATUS_VALUES },
                revision: { type: 'integer', required: true },
                goal_action: { type: 'string', required: true },
                recovery_command: { type: 'string', required: true },
            },
        }),
        async execute(args, exec) {
            const execution = researchToolExecution(ctx, exec);
            requireDirectHuman(ctx, execution);
            const result = await ctx.researcher.create(execution.agent, {
                goal: args.goal,
                metrics: args.metrics,
                baseline: args.baseline,
                ...(args.direction === undefined ? {} : { direction: args.direction }),
                ...(args.next === undefined ? {} : { next: args.next }),
            }, exec.signal);
            return {
                id: result.researchId,
                root: result.target.root,
                status: result.target.state.status,
                revision: result.target.state.revision,
                goal_action: result.goalAction,
                recovery_command: `/research-load ${result.researchId}`,
            };
        },
        presentCall: args => present('Create research target', 'other', args.goal),
    }));
    ctx.tools.register(defineTool({
        name: 'start_research',
        description: 'Start or resume automatic advancement of the already-loaded research target ONLY when the current direct human explicitly requests continuous work. '
            + 'Loading context, asking for a briefing, ordinary discussion, and a single task do not authorize this tool. '
            + 'No target switching; rejects subagents and automatic Goal rounds, completed targets and unfinished runs. '
            + 'Uses the researcher activation checks, resumes paused/blocked research state and creates or resumes the matching DSH Goal.',
        parameters: {},
        output: output({
            type: 'object',
            additionalProperties: false,
            properties: {
                id: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: STATUS_VALUES },
                goal_action: { type: 'string', required: true },
            },
        }),
        async execute(_args, exec) {
            const execution = researchToolExecution(ctx, exec);
            requireDirectHuman(ctx, execution);
            const result = await ctx.researcher.start(execution.agent, exec.signal);
            return { id: result.researchId, status: result.target.state.status, goal_action: result.goalAction };
        },
        presentCall: () => present('Start automatic research advancement', 'other'),
    }));
    ctx.tools.register(defineTool({
        name: 'update_research',
        description: 'Append one complete research state snapshot after a meaningful result or direction change. '
            + 'This does not update the DSH Goal lifecycle; call the native Goal tool separately when pausing, blocking, or completing.',
        parameters: {
            status: { type: 'string', required: true, enum: STATUS_VALUES },
            summary: { type: 'string', required: true },
            direction: { type: 'string' },
            next: { type: 'string' },
            last_run_id: { type: 'string' },
        },
        output: output({
            type: 'object',
            additionalProperties: false,
            properties: {
                id: { type: 'string', required: true },
                path: { type: 'string', required: true },
                state: { ...RESEARCH_STATE_OUTPUT, required: true },
                goal_followup: { type: 'string', required: true },
            },
        }),
        async execute(args, exec) {
            const execution = researchToolExecution(ctx, exec);
            const id = boundResearchId(ctx, execution);
            requireResearchMutation(ctx, execution, id);
            const result = await ctx.researcher.updateState(execution.agent, {
                status: args.status,
                summary: args.summary,
                ...(args.direction === undefined ? {} : { direction: args.direction }),
                ...(args.next === undefined ? {} : { next: args.next }),
                ...(args.last_run_id === undefined ? {} : { lastRunId: parseRunId(args.last_run_id) }),
            }, exec.signal);
            return {
                id,
                path: result.path,
                state: stateValue(result.state),
                goal_followup: 'Use get_goal/update_goal separately if this state changes the DSH Goal lifecycle.',
            };
        },
        presentCall: args => present(`Update research: ${args.status}`, 'other', args.summary),
    }));
    ctx.tools.register(defineTool({
        name: 'start_research_run',
        description: 'Create the single open immutable research run before every actual execution, rerun, seed change, or parameter change. '
            + 'Every new run, including a baseline or probe, requires an explicitly saved and selected plan revision; pass that exact plan. Pure reading/searching does not become a run. '
            + 'Only active research targets can start a run. Loading paused/blocked targets does not resume them; obtain explicit authorization to resume state, or use start_research for explicitly requested continuous work. '
            + 'Freeze Git input code with a reproduction recipe before execution. Requires a committed plain Git repository at the workspace root. '
            + 'By default capture tracked working files plus explicit reproduction.inputs. For large repositories opt into reproduction.snapshot scoped paths: a partial overlay on a pinned Git base, not a full working-tree snapshot. External inputs are retained separately and verified by size/SHA-256. Never include secrets. environment is descriptive, not injected. '
            + 'Finish any open run first. This tool does not execute the recipe; do not edit source during execution or claim snapshot capture proves reproducibility.',
        parameters: {
            purpose: { type: 'string', required: true },
            plan: { ...PLAN_SELECTOR, required: true },
            parameters: { type: 'object', required: true, additionalProperties: true },
            reproduction: {
                type: 'object', required: true, additionalProperties: false,
                properties: {
                    command: { type: 'string', required: true, description: 'Exact shell command/script including build and run steps, with no literal secrets.' },
                    cwd: { type: 'string', required: true, description: 'Project-relative command directory, or dot for the root.' },
                    environment: { type: 'object', required: true, additionalProperties: true, description: 'Non-secret environment/dependency/data versions, container digest and determinism constraints; descriptive only.' },
                    inputs: { type: 'array', required: true, items: { type: 'string' }, description: 'Explicit extra regular input/code files, including all needed untracked/ignored files. Tracked capture follows snapshot scope when supplied. No directories or symlinks.' },
                    snapshot: {
                        type: 'object', additionalProperties: false,
                        description: 'Opt-in bounded partial overlay. Preserve the pinned Git base, restore it before applying captured paths and deletions. Omitted tracked changes are reported but NOT captured. Caller must declare complete build/runtime dependency inputs.',
                        properties: {
                            mode: { type: 'string', required: true, enum: ['scoped'] },
                            paths: { type: 'array', required: true, items: { type: 'string' }, description: 'Nonempty canonical project-relative exact files or directory prefixes; no globs, dot root, metadata, or implicit untracked discovery.' },
                            omitChanges: { type: 'array', items: { type: 'string' }, description: 'Exact reviewed list of tracked changes outside capture scope. Omit when none; any unacknowledged outside change is an error. These changes are NOT captured.' },
                            externalInputs: {
                                type: 'array', description: 'Retained regular data files, not archived as code blobs. Checked at start and first finish; aggregate at most 1 GiB. Cannot also be in inputs.',
                                items: { type: 'object', additionalProperties: false, properties: {
                                        path: { type: 'string', required: true },
                                        bytes: { type: 'integer', required: true },
                                        sha256: { type: 'string', required: true },
                                    } },
                            },
                        },
                    },
                },
            },
        },
        output: output({
            type: 'object',
            additionalProperties: false,
            properties: {
                id: { type: 'string', required: true },
                run_id: { type: 'string', required: true },
                path: { type: 'string', required: true },
                checkpoint: { ...CHECKPOINT_OUTPUT, required: true },
                plan_ref: { ...PLAN_REF_OUTPUT, required: true },
            },
        }),
        async execute(args, exec) {
            const execution = researchToolExecution(ctx, exec);
            const id = boundResearchId(ctx, execution);
            requireResearchMutation(ctx, execution, id);
            const result = await ctx.researcher.startRun(execution.agent, {
                purpose: args.purpose,
                plan: { planId: args.plan.plan_id, revision: args.plan.revision },
                parameters: args.parameters,
                reproduction: args.reproduction,
            }, exec.signal);
            return { id, run_id: result.runId, path: result.path, plan_ref: planRefValue(result.planRef), checkpoint: {
                    input_commit: result.checkpoint.inputCommit,
                    input_ref: result.checkpoint.inputRef,
                    output_ref: result.checkpoint.outputRef,
                    verification: result.checkpoint.snapshot
                        ? 'scoped-overlay only; restore pinned base then overlay/deletions; retain external data; dependency completeness and reproduction unverified'
                        : 'snapshot-only; execute and independently compare results to verify reproducibility',
                    ...(result.checkpoint.snapshot ? { snapshot_mode: result.checkpoint.snapshot.mode, base_commit: result.checkpoint.baseHead,
                        captured_files: result.checkpoint.files.length, deleted_files: [...result.checkpoint.snapshot.deleted],
                        omitted_changes: [...result.checkpoint.snapshot.omittedChanges] } : {}),
                } };
        },
        presentCall: args => present('Start research run', 'other', args.purpose),
    }));
    ctx.tools.register(defineTool({
        name: 'finish_research_run',
        description: 'Finish exactly one open research run, verify its project-relative artifacts, and then append the resulting research state. '
            + 'For checkpoint runs, seal output code and SHA-256 artifact digests in Git before closing the record. Artifact paths must be regular files. '
            + 'A negative scientific outcome is completed; failed is only an execution failure. Results, checkpoint and prepared state are immutable; retry interrupted finish with the exact same payload, even if workspace files changed. No automatic rerun/restore or reproducibility guarantee.',
        parameters: {
            run_id: { type: 'string', required: true },
            status: { type: 'string', required: true, enum: RUN_STATUS_VALUES },
            result: { type: 'string', required: true },
            metrics: { type: 'object', required: true, additionalProperties: true },
            decision: { type: 'string', required: true },
            artifacts: { type: 'array', required: true, items: { type: 'string' } },
            research_status: { type: 'string', required: true, enum: STATUS_VALUES },
            summary: { type: 'string', required: true },
            direction: { type: 'string' },
            next: { type: 'string' },
        },
        output: output({
            type: 'object',
            additionalProperties: false,
            properties: {
                id: { type: 'string', required: true },
                run_id: { type: 'string', required: true },
                run_status: { type: 'string', required: true, enum: RUN_STATUS_VALUES },
                checkpoint: CHECKPOINT_OUTPUT,
                plan_ref: PLAN_REF_OUTPUT,
                research_state: { ...RESEARCH_STATE_OUTPUT, required: true },
                path: { type: 'string', required: true },
                goal_followup: { type: 'string', required: true },
            },
        }),
        async execute(args, exec) {
            const execution = researchToolExecution(ctx, exec);
            const id = boundResearchId(ctx, execution);
            requireResearchMutation(ctx, execution, id);
            const result = await ctx.researcher.finishRun(execution.agent, {
                runId: parseRunId(args.run_id),
                status: args.status,
                result: args.result,
                metrics: args.metrics,
                decision: args.decision,
                artifacts: args.artifacts,
                researchStatus: args.research_status,
                summary: args.summary,
                ...(args.direction === undefined ? {} : { direction: args.direction }),
                ...(args.next === undefined ? {} : { next: args.next }),
            }, exec.signal);
            return {
                id,
                run_id: result.runId,
                run_status: result.runStatus,
                ...(result.planRef === undefined ? {} : { plan_ref: planRefValue(result.planRef) }),
                ...(result.checkpoint === undefined ? {} : { checkpoint: {
                        input_commit: result.checkpoint.inputCommit, input_ref: result.checkpoint.inputRef,
                        output_commit: result.checkpoint.outputCommit, output_ref: result.checkpoint.outputRef,
                        code_changed: result.checkpoint.codeChanged,
                        verification: result.checkpoint.snapshot
                            ? 'scoped-overlay only; code_changed describes captured paths, not the full repository; no independent reproduction performed'
                            : 'snapshot-only; no independent reproduction was performed',
                        ...(result.checkpoint.snapshot ? { snapshot_mode: result.checkpoint.snapshot.mode, base_commit: result.checkpoint.snapshot.baseHead,
                            deleted_files: [...result.checkpoint.snapshot.deleted] } : {}),
                    } }),
                research_state: stateValue(result.state),
                path: result.path,
                goal_followup: 'If research_status pauses, blocks, or completes the objective, update the native DSH Goal separately now.',
            };
        },
        presentCall: args => present(`Finish run: ${args.status}`, 'other', args.decision),
    }));
    ctx.tools.register(defineTool({
        name: 'update_research_glossary',
        description: 'Atomically patch only goal-relevant terminology and relevant-file descriptions. '
            + 'String values upsert; null deletes. Do not add broad project crawling metadata, aliases, scores, or transcript content.',
        parameters: {
            terms: { type: 'object', additionalProperties: true },
            files: { type: 'object', additionalProperties: true },
        },
        output: output({
            type: 'object',
            additionalProperties: false,
            properties: {
                id: { type: 'string', required: true },
                path: { type: 'string', required: true },
                term_count: { type: 'integer', required: true },
                file_count: { type: 'integer', required: true },
            },
        }),
        async execute(args, exec) {
            const execution = researchToolExecution(ctx, exec);
            const id = boundResearchId(ctx, execution);
            requireResearchMutation(ctx, execution, id);
            const terms = stringNullMap('terms', args.terms);
            const files = stringNullMap('files', args.files);
            const patch = {
                ...(terms === undefined ? {} : { terms }),
                ...(files === undefined ? {} : { files }),
            };
            const result = await ctx.researcher.updateGlossary(execution.agent, patch, exec.signal);
            return { id, path: result.path, term_count: result.termCount, file_count: result.fileCount };
        },
        presentCall: () => present('Update research glossary', 'other'),
    }));
}
//# sourceMappingURL=tool.js.map