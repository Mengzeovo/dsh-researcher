import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type { GenericCallView, InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from './index.ts'
import { requireDirectHuman, requireResearchMutation, researchToolExecution } from './authority.ts'
import { ResearcherError, invalidRecord } from './errors.ts'
import { parseRunId } from './schema.ts'
import type { ResearchGlossaryPatch, ResearchId, ResearchState } from './types.ts'

export const name = 'tool-researcher'
export const inject = ['agents', 'goals', 'researcher', 'sessionProjections', 'tools']

const STATUS_VALUES = ['active', 'paused', 'blocked', 'complete'] as const
const RUN_STATUS_VALUES = ['completed', 'failed'] as const
const CHECKPOINT_OUTPUT = {
  type: 'object', additionalProperties: false,
  properties: {
    input_commit: { type: 'string', required: true },
    input_ref: { type: 'string', required: true },
    output_commit: { type: 'string' },
    output_ref: { type: 'string', required: true },
    code_changed: { type: 'boolean' },
    verification: { type: 'string', required: true },
  },
} as const

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
} as const

function output<const S extends ValueSchemaSpec>(schema: S) {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  }
}

function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...(rawInput === undefined ? {} : { rawInput }) }
}

function boundResearchId(ctx: Context, execution: ReturnType<typeof researchToolExecution>): ResearchId {
  const binding = ctx.researcher.binding(execution.agent.session)
  if (binding === undefined) {
    throw new ResearcherError(
      'no research target is loaded; ask the human to use /research-load <research-id>',
      'RESEARCH_NOT_FOUND',
    )
  }
  return binding.researchId
}

function stateValue(state: ResearchState) {
  return {
    revision: state.revision,
    status: state.status,
    at: state.at,
    summary: state.summary,
    ...(state.direction === undefined ? {} : { direction: state.direction }),
    ...(state.next === undefined ? {} : { next: state.next }),
    ...(state.lastRunId === undefined ? {} : { last_run_id: state.lastRunId }),
  }
}

function stringNullMap(subject: string, value: Record<string, JsonValue> | undefined): Record<string, string | null> | undefined {
  if (value === undefined) return undefined
  const mapped: Record<string, string | null> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' && item !== null) invalidRecord(`${subject}.${key} must be a string or null`)
    mapped[key] = item
  }
  return mapped
}

export function apply(ctx: Context): void {
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
            recovery: {
              type: 'object', additionalProperties: false,
              properties: {
                run_id: { type: 'string', required: true },
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
      const execution = researchToolExecution(ctx, exec)
      const result = await ctx.researcher.get(execution.agent, exec.signal)
      const state = result.target.state
      const recovery = result.target.recovery
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
          ...(recovery === undefined ? {} : { recovery: {
            run_id: recovery.runId, phase: recovery.phase, path: recovery.path,
            ...(recovery.outputRef === undefined ? {} : { output_ref: recovery.outputRef }),
          } }),
          warnings: [...result.target.warnings],
          context: result.context.text,
        },
      }
    },
    isConcurrencySafe: () => true,
    presentCall: () => present('Read research target', 'read'),
  }))

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
      const execution = researchToolExecution(ctx, exec)
      requireDirectHuman(ctx, execution)
      const result = await ctx.researcher.create(execution.agent, {
        goal: args.goal,
        metrics: args.metrics,
        baseline: args.baseline,
        ...(args.direction === undefined ? {} : { direction: args.direction }),
        ...(args.next === undefined ? {} : { next: args.next }),
      }, exec.signal)
      return {
        id: result.researchId,
        root: result.target.root,
        status: result.target.state.status,
        revision: result.target.state.revision,
        goal_action: result.goalAction,
        recovery_command: `/research-load ${result.researchId}`,
      }
    },
    presentCall: args => present('Create research target', 'other', args.goal),
  }))

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
      const execution = researchToolExecution(ctx, exec)
      const id = boundResearchId(ctx, execution)
      requireResearchMutation(ctx, execution, id)
      const result = await ctx.researcher.updateState(execution.agent, {
        status: args.status,
        summary: args.summary,
        ...(args.direction === undefined ? {} : { direction: args.direction }),
        ...(args.next === undefined ? {} : { next: args.next }),
        ...(args.last_run_id === undefined ? {} : { lastRunId: parseRunId(args.last_run_id) }),
      }, exec.signal)
      return {
        id,
        path: result.path,
        state: stateValue(result.state),
        goal_followup: 'Use get_goal/update_goal separately if this state changes the DSH Goal lifecycle.',
      }
    },
    presentCall: args => present(`Update research: ${args.status}`, 'other', args.summary),
  }))

  ctx.tools.register(defineTool({
    name: 'start_research_run',
    description: 'Create the single open immutable research run before every actual execution, rerun, seed change, or parameter change. '
      + 'Only active research targets can start a run; ask the human to /research-load paused/blocked targets to recover or resume them first. '
      + 'Freeze Git input code with a reproduction recipe before execution. Requires a committed plain Git repository at the workspace root. '
      + 'Tracked working files and explicit reproduction.inputs are captured; never include secrets. environment is descriptive, not injected. '
      + 'Finish any open run first. This tool does not execute the recipe; do not edit source during execution or claim snapshot capture proves reproducibility.',
    parameters: {
      purpose: { type: 'string', required: true },
      parameters: { type: 'object', required: true, additionalProperties: true },
      reproduction: {
        type: 'object', required: true, additionalProperties: false,
        properties: {
          command: { type: 'string', required: true, description: 'Exact shell command/script including build and run steps, with no literal secrets.' },
          cwd: { type: 'string', required: true, description: 'Project-relative command directory, or dot for the root.' },
          environment: { type: 'object', required: true, additionalProperties: true, description: 'Non-secret environment/dependency/data versions, container digest and determinism constraints; descriptive only.' },
          inputs: { type: 'array', required: true, items: { type: 'string' }, description: 'Explicit extra regular input/code files including needed untracked/ignored files. Tracked working files are captured automatically. No directories.' },
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
      },
    }),
    async execute(args, exec) {
      const execution = researchToolExecution(ctx, exec)
      const id = boundResearchId(ctx, execution)
      requireResearchMutation(ctx, execution, id)
      const result = await ctx.researcher.startRun(execution.agent, {
        purpose: args.purpose,
        parameters: args.parameters,
        reproduction: args.reproduction,
      }, exec.signal)
      return { id, run_id: result.runId, path: result.path, checkpoint: {
        input_commit: result.checkpoint.inputCommit,
        input_ref: result.checkpoint.inputRef,
        output_ref: result.checkpoint.outputRef,
        verification: 'snapshot-only; execute and independently compare results to verify reproducibility',
      } }
    },
    presentCall: args => present('Start research run', 'other', args.purpose),
  }))

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
        research_state: { ...RESEARCH_STATE_OUTPUT, required: true },
        path: { type: 'string', required: true },
        goal_followup: { type: 'string', required: true },
      },
    }),
    async execute(args, exec) {
      const execution = researchToolExecution(ctx, exec)
      const id = boundResearchId(ctx, execution)
      requireResearchMutation(ctx, execution, id)
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
      }, exec.signal)
      return {
        id,
        run_id: result.runId,
        run_status: result.runStatus,
        ...(result.checkpoint === undefined ? {} : { checkpoint: {
          input_commit: result.checkpoint.inputCommit, input_ref: result.checkpoint.inputRef,
          output_commit: result.checkpoint.outputCommit, output_ref: result.checkpoint.outputRef,
          code_changed: result.checkpoint.codeChanged,
          verification: 'snapshot-only; no independent reproduction was performed',
        } }),
        research_state: stateValue(result.state),
        path: result.path,
        goal_followup: 'If research_status pauses, blocks, or completes the objective, update the native DSH Goal separately now.',
      }
    },
    presentCall: args => present(`Finish run: ${args.status}`, 'other', args.decision),
  }))

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
      const execution = researchToolExecution(ctx, exec)
      const id = boundResearchId(ctx, execution)
      requireResearchMutation(ctx, execution, id)
      const terms = stringNullMap('terms', args.terms)
      const files = stringNullMap('files', args.files)
      const patch: ResearchGlossaryPatch = {
        ...(terms === undefined ? {} : { terms }),
        ...(files === undefined ? {} : { files }),
      }
      const result = await ctx.researcher.updateGlossary(execution.agent, patch, exec.signal)
      return { id, path: result.path, term_count: result.termCount, file_count: result.fileCount }
    },
    presentCall: () => present('Update research glossary', 'other'),
  }))
}
