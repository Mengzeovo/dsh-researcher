import { defineTool } from '@deepseek-ai/dsh-tools';
import { requireDirectHuman, requireResearchMutation, researchToolExecution } from "./authority.js";
import { ResearcherError, invalidRecord } from "./errors.js";
import { parseRunId } from "./schema.js";
export const name = 'tool-researcher';
export const inject = ['agents', 'goals', 'researcher', 'sessionProjections', 'tools'];
const STATUS_VALUES = ['active', 'paused', 'blocked', 'complete'];
const RUN_STATUS_VALUES = ['completed', 'failed'];
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
function stateValue(state) {
    return {
        revision: state.revision,
        status: state.status,
        at: state.at,
        summary: state.summary,
        ...(state.direction === undefined ? {} : { direction: state.direction }),
        ...(state.next === undefined ? {} : { next: state.next }),
        ...(state.lastRunId === undefined ? {} : { last_run_id: state.lastRunId }),
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
        name: 'get_research',
        description: 'Read the currently loaded cross-session research target and its bounded authoritative snapshot. '
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
            + 'parameters must be lossless JSON. Finish any existing open run first; starting a run does not execute the experiment itself.',
        parameters: {
            purpose: { type: 'string', required: true },
            parameters: { type: 'object', required: true, additionalProperties: true },
        },
        output: output({
            type: 'object',
            additionalProperties: false,
            properties: {
                id: { type: 'string', required: true },
                run_id: { type: 'string', required: true },
                path: { type: 'string', required: true },
            },
        }),
        async execute(args, exec) {
            const execution = researchToolExecution(ctx, exec);
            const id = boundResearchId(ctx, execution);
            requireResearchMutation(ctx, execution, id);
            const result = await ctx.researcher.startRun(execution.agent, {
                purpose: args.purpose,
                parameters: args.parameters,
            }, exec.signal);
            return { id, run_id: result.runId, path: result.path };
        },
        presentCall: args => present('Start research run', 'other', args.purpose),
    }));
    ctx.tools.register(defineTool({
        name: 'finish_research_run',
        description: 'Finish exactly one open research run, verify its project-relative artifacts, and then append the resulting research state. '
            + 'A negative scientific outcome is completed; failed is only an execution failure. Results and the prepared state transition are immutable; retry an interrupted finish with the exact same payload.',
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