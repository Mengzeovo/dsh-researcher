import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { FsError, type FsTarget, type FsVersion } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { buildResearchContext } from './context.ts'
import { commitResearchDirectory, discardResearchStaging, ensureResearchDirectories } from './directories.ts'
import { ResearcherError, invalidRecord } from './errors.ts'
import { appendStateText, parseRunLog, parseStateLog, renderClosedRun, renderOpenRun } from './jsonl.ts'
import {
  RECORD_MAX_BYTES,
  SESSION_INDEX_MAX_BYTES,
  encodeSessionId,
  nowIso,
  normalizeProjectRelativePath,
  parseGoalMarkdown,
  parseJsonText,
  parseResearchId,
  parseRunId,
  renderGoalMarkdown,
  researchGlossarySchema,
  researchRunDescriptionSchema,
  researchRunResultSchema,
  researchSessionIndexSchema,
  researchStateSchema,
  stableJsonLine,
  truncateLabel,
} from './schema.ts'
import type {
  CreateResearchRequest,
  FinishResearchRunRequest,
  ResearchBinding,
  ResearchGlossary,
  ResearchGlossaryPatch,
  ResearchGlossaryResult,
  ResearchId,
  ResearchRun,
  ResearchRunFinishResult,
  ResearchRunStartResult,
  ResearchSessionIndex,
  ResearchState,
  ResearchStateResult,
  ResearchTargetSnapshot,
  ResearchTargetSummary,
  InvalidResearchTargetSummary,
  RunId,
  StartResearchRunRequest,
  UpdateResearchRequest,
} from './types.ts'

interface VersionedText {
  readonly target: FsTarget
  readonly version: FsVersion
  readonly text: string
}

interface TargetListResult {
  readonly targets: readonly ResearchTargetSummary[]
  readonly invalid: readonly InvalidResearchTargetSummary[]
}

class FifoMutex {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function sessionCwd(session: Session): string {
  const cwd = session.header.cwd
  if (cwd === undefined) throw new ResearcherError('researcher requires a session workspace cwd', 'RESEARCH_PATH_INVALID')
  return cwd
}

function pathOptions(session: Session, signal?: AbortSignal): { cwd: string; signal?: AbortSignal } {
  const cwd = sessionCwd(session)
  return signal === undefined ? { cwd } : { cwd, signal }
}

function contextBinding(session: Session, id: ResearchId, loadedAt: string): ResearchBinding {
  return {
    version: 1,
    researchId: id,
    sessionId: String(session.id),
    loadedAt,
  }
}

function assertContextFits(session: Session, target: ResearchTargetSnapshot, loadedAt: string): void {
  buildResearchContext(target, contextBinding(session, target.id, loadedAt))
}

function targetRoot(id: ResearchId): string {
  return `.research/goal/${id}`
}

function statePath(id: ResearchId): string {
  return `${targetRoot(id)}/state.jsonl`
}

function glossaryPath(id: ResearchId): string {
  return `${targetRoot(id)}/glossary.json`
}

function runPath(id: ResearchId, runId: RunId): string {
  return `${targetRoot(id)}/runs/${runId}.jsonl`
}

function sessionPath(id: ResearchId, sessionId: string): string {
  return `${targetRoot(id)}/session/${encodeSessionId(sessionId)}.json`
}

function cloneJsonRecord(value: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  const parsed = z.record(z.string(), z.json()).safeParse(value)
  if (!parsed.success) invalidRecord(`JSON map is not lossless JSON: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

function mapWriteError(error: unknown, subject: string): never {
  if (error instanceof FsError && (error.code === 'FS_STALE_VERSION' || error.code === 'FS_NOT_OBSERVED')) {
    throw new ResearcherError(`${subject} changed concurrently; reload and retry`, 'RESEARCH_STALE_WRITE', { cause: error })
  }
  throw error
}

function stateFieldsMatch(left: ResearchState, right: Omit<ResearchState, 'version' | 'revision' | 'at' | 'sessionId'>): boolean {
  return left.status === right.status
    && left.summary === right.summary
    && left.direction === right.direction
    && left.next === right.next
    && left.lastRunId === right.lastRunId
}

/** Authoritative project-file store. It contains no Goal or model-turn policy. */
export class ResearchStore {
  private readonly mutexes = new Map<string, FifoMutex>()
  private readonly logger

  constructor(private readonly ctx: Context) {
    this.logger = ctx.logger('researcher.store')
  }

  private mutex(session: Session, id: ResearchId): FifoMutex {
    const key = `${sessionCwd(session)}\u0000${id}`
    let mutex = this.mutexes.get(key)
    if (mutex === undefined) {
      mutex = new FifoMutex()
      this.mutexes.set(key, mutex)
    }
    return mutex
  }

  private async workspaceTarget(session: Session, signal?: AbortSignal): Promise<FsTarget> {
    const target = await this.ctx.fs.resolve('.', pathOptions(session, signal))
    const info = await this.ctx.fs.stat(target, signal)
    if (info?.type !== 'directory') {
      throw new ResearcherError('session workspace is not an accessible directory', 'RESEARCH_PATH_INVALID')
    }
    return target
  }

  private async resolveContained(session: Session, relative: string, signal?: AbortSignal): Promise<FsTarget> {
    const root = await this.workspaceTarget(session, signal)
    const target = await this.ctx.fs.resolve(relative, pathOptions(session, signal))
    if (!this.ctx.fs.contains(root, target)) {
      throw new ResearcherError(`research path escapes the project root: ${relative}`, 'RESEARCH_PATH_INVALID')
    }
    return target
  }

  private async assertRealDirectory(session: Session, relative: string, signal?: AbortSignal): Promise<void> {
    const info = await this.ctx.fs.lstat(relative, { cwd: sessionCwd(session) }, signal)
    if (info === undefined) throw new ResearcherError(`missing research directory: ${relative}`, 'RESEARCH_NOT_FOUND')
    if (info.type !== 'directory') {
      throw new ResearcherError(`research directory is a symlink or non-directory: ${relative}`, 'RESEARCH_PATH_INVALID')
    }
  }

  private async assertRealFile(session: Session, relative: string, signal?: AbortSignal): Promise<void> {
    const info = await this.ctx.fs.lstat(relative, { cwd: sessionCwd(session) }, signal)
    if (info === undefined) throw new ResearcherError(`research file not found: ${relative}`, 'RESEARCH_NOT_FOUND')
    if (info.type !== 'file') {
      throw new ResearcherError(`research authority file is a symlink or non-file: ${relative}`, 'RESEARCH_PATH_INVALID')
    }
  }

  private async resolveAuthorityContained(
    session: Session,
    id: ResearchId,
    relative: string,
    signal?: AbortSignal,
  ): Promise<FsTarget> {
    const root = await this.resolveContained(session, targetRoot(id), signal)
    const target = await this.resolveContained(session, relative, signal)
    if (!this.ctx.fs.contains(root, target)) {
      throw new ResearcherError(`research authority path escapes target ${id}: ${relative}`, 'RESEARCH_PATH_INVALID')
    }
    return target
  }

  private async readVersioned(
    session: Session,
    id: ResearchId,
    relative: string,
    maxBytes: number | undefined,
    signal?: AbortSignal,
  ): Promise<VersionedText> {
    await this.assertRealFile(session, relative, signal)
    const target = await this.resolveAuthorityContained(session, id, relative, signal)
    const info = await this.ctx.fs.stat(target, signal)
    if (info === undefined) throw new ResearcherError(`research file not found: ${relative}`, 'RESEARCH_NOT_FOUND')
    if (info.type !== 'file') throw new ResearcherError(`research path is not a regular file: ${relative}`, 'RESEARCH_INVALID_RECORD')
    if (maxBytes !== undefined && info.size !== undefined && info.size > maxBytes) {
      throw new ResearcherError(`${relative} exceeds ${maxBytes} bytes`, 'RESEARCH_OVERSIZED')
    }
    const text = maxBytes === undefined
      ? await this.readStream(target, signal)
      : await this.ctx.fs.readText(target, signal)
    if (maxBytes !== undefined && Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new ResearcherError(`${relative} exceeds ${maxBytes} bytes`, 'RESEARCH_OVERSIZED')
    }
    return { target, version: info.version, text }
  }

  private async readStream(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const stream = await this.ctx.fs.streamText(target, signal)
    let text = ''
    for await (const chunk of stream) text += chunk
    return text
  }

  private writePolicy(session: Session): SandboxExecutionPolicy {
    const policy = this.ctx.sandboxPolicy.resolve({ session })
    if (policy.mode === 'read-only') {
      throw new ResearcherError('research project records cannot be changed while the session is read-only', 'RESEARCH_PATH_INVALID')
    }
    return policy
  }

  private async createText(
    session: Session,
    relative: string,
    content: string,
    policy: SandboxExecutionPolicy,
    signal?: AbortSignal,
  ): Promise<void> {
    const target = await this.resolveContained(session, relative, signal)
    try {
      await this.ctx.fs.writeText(target, content, { kind: 'createIfAbsent' }, signal, policy)
    } catch (error) {
      mapWriteError(error, relative)
    }
  }

  private async replaceText(
    session: Session,
    observed: Pick<VersionedText, 'target' | 'version'>,
    relative: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.ctx.fs.writeText(
        observed.target,
        content,
        { kind: 'replaceIfVersion', version: observed.version },
        signal,
        this.writePolicy(session),
      )
    } catch (error) {
      mapWriteError(error, relative)
    }
  }

  async createTarget(
    session: Session,
    request: CreateResearchRequest,
    signal?: AbortSignal,
  ): Promise<ResearchTargetSnapshot> {
    const id = parseResearchId(randomUUID())
    return await this.mutex(session, id).run(async () => {
      const stagingName = `.creating-${id}`
      const stagingRoot = `.research/goal/${stagingName}`
      const finalRoot = targetRoot(id)
      const at = nowIso()
      const markdown = renderGoalMarkdown(request.goal, request.metrics, request.baseline)
      const parsedGoal = parseGoalMarkdown(markdown)
      const state: ResearchState = researchStateSchema.parse({
        version: 1,
        revision: 1,
        at,
        sessionId: String(session.id),
        status: 'active',
        summary: parsedGoal.description,
        ...(request.direction === undefined ? {} : { direction: request.direction }),
        ...(request.next === undefined ? {} : { next: request.next }),
      })
      const glossary: ResearchGlossary = researchGlossarySchema.parse({ version: 1, terms: {}, files: {} })
      const index: ResearchSessionIndex = researchSessionIndexSchema.parse({
        version: 1,
        sessionId: String(session.id),
        loadedAt: at,
        runIds: [],
      })
      const initialTarget: ResearchTargetSnapshot = {
        id,
        root: finalRoot,
        goalPath: `${finalRoot}/goal.md`,
        goal: parsedGoal,
        state,
        glossary,
        warnings: [],
      }
      assertContextFits(session, initialTarget, at)
      const directories = [
        '.research',
        '.research/goal',
        '.research/evo',
        stagingRoot,
        `${stagingRoot}/session`,
        `${stagingRoot}/runs`,
      ]
      const policy = await ensureResearchDirectories(this.ctx, session, directories)
      try {
        await this.createText(session, `${stagingRoot}/goal.md`, markdown, policy, signal)
        await this.createText(session, `${stagingRoot}/state.jsonl`, `${stableJsonLine(state)}\n`, policy, signal)
        await this.createText(session, `${stagingRoot}/glossary.json`, `${JSON.stringify(glossary, null, 2)}\n`, policy, signal)
        await this.createText(
          session,
          `${stagingRoot}/session/${encodeSessionId(String(session.id))}.json`,
          `${JSON.stringify(index, null, 2)}\n`,
          policy,
          signal,
        )
        await commitResearchDirectory(this.ctx, session, stagingRoot, finalRoot)
      } catch (error) {
        await discardResearchStaging(this.ctx, session, stagingRoot).catch(cleanupError => {
          this.logger.warn('failed to discard research staging directory %s: %s', stagingRoot, String(cleanupError))
        })
        throw error
      }
      return await this.readTarget(session, id, signal)
    })
  }

  async readTarget(session: Session, idInput: ResearchId | string, signal?: AbortSignal): Promise<ResearchTargetSnapshot> {
    const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput
    const root = targetRoot(id)
    await this.assertRealDirectory(session, '.research', signal)
    await this.assertRealDirectory(session, '.research/goal', signal)
    await this.assertRealDirectory(session, root, signal)
    await this.assertRealDirectory(session, `${root}/session`, signal)
    await this.assertRealDirectory(session, `${root}/runs`, signal)

    const goalFile = await this.readVersioned(session, id, `${root}/goal.md`, RECORD_MAX_BYTES, signal)
    const goal = parseGoalMarkdown(goalFile.text)
    const stateFile = await this.readVersioned(session, id, `${root}/state.jsonl`, undefined, signal)
    const stateLog = parseStateLog(stateFile.text)
    const state = stateLog.states.at(-1)
    if (state === undefined) invalidRecord(`${root}/state.jsonl has no current state`)
    const glossaryFile = await this.readVersioned(session, id, `${root}/glossary.json`, RECORD_MAX_BYTES, signal)
    const glossary = parseJsonText(`${root}/glossary.json`, glossaryFile.text, researchGlossarySchema, RECORD_MAX_BYTES)
    const warnings: string[] = []
    if (stateLog.warning !== undefined) warnings.push(stateLog.warning)
    await this.validateGlossaryFiles(session, glossary, warnings, signal)
    let latestRun: ResearchRun | undefined
    if (state.lastRunId !== undefined) {
      latestRun = await this.readRun(session, id, state.lastRunId, signal)
      if (latestRun.result === undefined) {
        invalidRecord(`${statePath(id)} lastRunId ${state.lastRunId} refers to an open run`)
      }
    }
    return {
      id,
      root,
      goalPath: `${root}/goal.md`,
      goal,
      state,
      glossary,
      ...(latestRun === undefined ? {} : { latestRun }),
      warnings,
    }
  }

  async listTargets(session: Session, signal?: AbortSignal): Promise<TargetListResult> {
    const root = await this.resolveContained(session, '.research/goal', signal)
    const info = await this.ctx.fs.stat(root, signal)
    if (info === undefined) return { targets: [], invalid: [] }
    if (info.type !== 'directory') {
      throw new ResearcherError('.research/goal is not a directory', 'RESEARCH_PATH_INVALID')
    }
    await this.assertRealDirectory(session, '.research', signal)
    await this.assertRealDirectory(session, '.research/goal', signal)
    const entries = await this.ctx.fs.listDir(root, signal)
    const targets: ResearchTargetSummary[] = []
    const invalid: InvalidResearchTargetSummary[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.creating-')) continue
      let id: ResearchId
      try {
        id = parseResearchId(entry.name)
      } catch {
        continue
      }
      if (entry.type !== 'directory') {
        invalid.push({ id, code: 'RESEARCH_INVALID_RECORD', detail: 'target path is not a directory' })
        continue
      }
      try {
        const target = await this.readTarget(session, id, signal)
        targets.push({
          id,
          description: truncateLabel(target.goal.description),
          status: target.state.status,
          updatedAt: target.state.at,
          warningCount: target.warnings.length,
        })
      } catch (error) {
        invalid.push({
          id,
          code: error instanceof ResearcherError ? error.code : 'RESEARCH_INVALID_RECORD',
          detail: this.shortError(error),
        })
      }
    }
    targets.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    invalid.sort((left, right) => left.id.localeCompare(right.id))
    return { targets, invalid }
  }

  async appendState(
    session: Session,
    idInput: ResearchId | string,
    request: UpdateResearchRequest,
    signal?: AbortSignal,
  ): Promise<ResearchStateResult> {
    const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput
    return await this.mutex(session, id).run(async () => await this.appendStateLocked(session, id, request, signal))
  }

  private async appendStateLocked(
    session: Session,
    id: ResearchId,
    request: UpdateResearchRequest,
    signal?: AbortSignal,
  ): Promise<ResearchStateResult> {
    const target = await this.readTarget(session, id, signal)
    const stateFile = await this.readVersioned(session, id, statePath(id), undefined, signal)
    const log = parseStateLog(stateFile.text)
    const current = log.states.at(-1)
    if (current === undefined) invalidRecord(`${statePath(id)} has no current state`)
    if (current.revision !== target.state.revision) {
      throw new ResearcherError(`${statePath(id)} changed while preparing the update`, 'RESEARCH_STALE_WRITE')
    }
    if (current.status === 'complete') {
      throw new ResearcherError(`research target ${id} is complete and cannot be reopened in v1`, 'RESEARCH_TARGET_COMPLETE')
    }
    const pendingRun = await this.findPendingTransition(session, id, current.revision, signal)
    if (pendingRun !== undefined) {
      throw new ResearcherError(
        `closed run ${pendingRun} must finish publishing its prepared state before another state update`,
        'RESEARCH_STALE_WRITE',
      )
    }
    if (request.status === 'complete') {
      const openRun = await this.findOpenRun(session, id, signal)
      if (openRun !== undefined) {
        throw new ResearcherError(
          `research run ${openRun} is still open; finish it before completing the target`,
          'RESEARCH_RUN_OPEN',
        )
      }
    }
    let latestRun: ResearchRun | undefined
    if (request.lastRunId !== undefined) {
      latestRun = await this.readRun(session, id, request.lastRunId, signal)
      if (latestRun.result === undefined) invalidRecord(`lastRunId ${request.lastRunId} refers to an open run`)
    }
    const state = researchStateSchema.parse({
      version: 1,
      revision: current.revision + 1,
      at: nowIso(),
      sessionId: String(session.id),
      status: request.status,
      summary: request.summary,
      ...(request.direction === undefined ? {} : { direction: request.direction }),
      ...(request.next === undefined ? {} : { next: request.next }),
      ...(request.lastRunId === undefined ? {} : { lastRunId: request.lastRunId }),
    })
    const prospective: ResearchTargetSnapshot = {
      id: target.id,
      root: target.root,
      goalPath: target.goalPath,
      goal: target.goal,
      state,
      glossary: target.glossary,
      ...(latestRun === undefined ? {} : { latestRun }),
      warnings: target.warnings,
    }
    assertContextFits(session, prospective, state.at)
    await this.replaceText(session, stateFile, statePath(id), appendStateText(log, state), signal)
    return { researchId: id, state, path: statePath(id) }
  }

  async resumeState(session: Session, idInput: ResearchId | string, signal?: AbortSignal): Promise<ResearchTargetSnapshot> {
    const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput
    return await this.mutex(session, id).run(async () => {
      const target = await this.readTarget(session, id, signal)
      if (target.state.status !== 'paused' && target.state.status !== 'blocked') return target
      await this.appendStateLocked(session, id, {
        status: 'active',
        summary: target.state.summary,
        ...(target.state.direction === undefined ? {} : { direction: target.state.direction }),
        ...(target.state.next === undefined ? {} : { next: target.state.next }),
        ...(target.state.lastRunId === undefined ? {} : { lastRunId: target.state.lastRunId }),
      }, signal)
      return await this.readTarget(session, id, signal)
    })
  }

  async startRun(
    session: Session,
    idInput: ResearchId | string,
    request: StartResearchRunRequest,
    signal?: AbortSignal,
  ): Promise<ResearchRunStartResult> {
    const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput
    return await this.mutex(session, id).run(async () => {
      const target = await this.readTarget(session, id, signal)
      if (target.state.status === 'complete') {
        throw new ResearcherError(`research target ${id} is complete`, 'RESEARCH_TARGET_COMPLETE')
      }
      const pendingRun = await this.findPendingTransition(session, id, target.state.revision, signal)
      if (pendingRun !== undefined) {
        throw new ResearcherError(
          `closed run ${pendingRun} must finish publishing its prepared state before another run starts`,
          'RESEARCH_STALE_WRITE',
        )
      }
      const openRun = await this.findOpenRun(session, id, signal)
      if (openRun !== undefined) {
        throw new ResearcherError(
          `research run ${openRun} is still open; finish it before starting another execution`,
          'RESEARCH_RUN_OPEN',
        )
      }
      const runId = parseRunId(randomUUID())
      const description = researchRunDescriptionSchema.parse({
        version: 1,
        type: 'description',
        createdAt: nowIso(),
        sessionId: String(session.id),
        purpose: request.purpose,
        parameters: cloneJsonRecord(request.parameters),
      })
      const policy = this.writePolicy(session)
      await this.createText(session, runPath(id, runId), renderOpenRun(description), policy, signal)
      await this.ensureSessionIndex(session, id, signal).catch(error => {
        this.logger.warn('run %s was created but its rebuildable session index was not updated: %s', runId, String(error))
      })
      return { researchId: id, runId, path: runPath(id, runId) }
    })
  }

  async finishRun(
    session: Session,
    idInput: ResearchId | string,
    request: FinishResearchRunRequest,
    signal?: AbortSignal,
  ): Promise<ResearchRunFinishResult> {
    const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput
    return await this.mutex(session, id).run(async () => {
      const runFile = await this.readVersioned(session, id, runPath(id, request.runId), undefined, signal)
      const run = parseRunLog(request.runId, runFile.text)
      const metrics = cloneJsonRecord(request.metrics)
      const requestedState = {
        status: request.researchStatus,
        summary: request.summary,
        ...(request.direction === undefined ? {} : { direction: request.direction }),
        ...(request.next === undefined ? {} : { next: request.next }),
        lastRunId: request.runId,
      } as const

      let closedRun: ResearchRun
      if (run.result !== undefined) {
        const artifacts = this.normalizeArtifactPaths(request.artifacts)
        if (run.result.status !== request.status
          || run.result.result !== request.result
          || !isDeepStrictEqual(run.result.metrics, metrics)
          || run.result.decision !== request.decision
          || !isDeepStrictEqual(run.result.artifacts, artifacts)
          || !stateFieldsMatch(run.result.transition, requestedState)) {
          throw new ResearcherError(`run ${request.runId} is already closed with a different immutable result or transition`, 'RESEARCH_RUN_CLOSED')
        }
        closedRun = run
      } else {
        const currentTarget = await this.readTarget(session, id, signal)
        if (currentTarget.state.status === 'complete') {
          throw new ResearcherError(`research target ${id} is complete`, 'RESEARCH_TARGET_COMPLETE')
        }
        const openRun = await this.findOpenRun(session, id, signal)
        if (openRun !== request.runId) {
          throw new ResearcherError(
            openRun === undefined
              ? `run ${request.runId} is not the target's open run`
              : `research run ${openRun} is the target's open run`,
            'RESEARCH_RUN_OPEN',
          )
        }
        const artifacts = await this.validateArtifacts(session, request.artifacts, signal)
        const transition = researchStateSchema.parse({
          version: 1,
          revision: currentTarget.state.revision + 1,
          at: nowIso(),
          sessionId: String(session.id),
          ...requestedState,
        })
        const result = researchRunResultSchema.parse({
          version: 1,
          type: 'result',
          finishedAt: nowIso(),
          status: request.status,
          result: request.result,
          metrics,
          decision: request.decision,
          artifacts,
          transition,
        })
        closedRun = { ...run, result }
        const prospective: ResearchTargetSnapshot = {
          ...currentTarget,
          state: transition,
          latestRun: closedRun,
        }
        assertContextFits(session, prospective, transition.at)
        const closedText = renderClosedRun(run.description, result)
        await this.replaceText(session, runFile, runPath(id, request.runId), closedText, signal)
      }

      const state = await this.appendPreparedRunState(session, id, closedRun, signal)
      await this.ensureSessionIndex(session, id, signal).catch(error => {
        this.logger.warn('run %s finished but its rebuildable session index was not updated: %s', request.runId, String(error))
      })
      return {
        researchId: id,
        runId: request.runId,
        runStatus: closedRun.result!.status,
        state,
        path: runPath(id, request.runId),
      }
    })
  }

  private async appendPreparedRunState(
    session: Session,
    id: ResearchId,
    run: ResearchRun,
    signal?: AbortSignal,
  ): Promise<ResearchState> {
    const result = run.result
    if (result === undefined || result.transition.lastRunId !== run.id) {
      invalidRecord(`closed run ${run.id} does not carry its exact state transition`)
    }
    const transition = result.transition
    const target = await this.readTarget(session, id, signal)
    if (isDeepStrictEqual(target.state, transition)) return target.state
    if (target.state.status === 'complete') {
      throw new ResearcherError(`research target ${id} is complete`, 'RESEARCH_TARGET_COMPLETE')
    }
    if (target.state.revision + 1 !== transition.revision) {
      throw new ResearcherError(
        `closed run ${run.id} prepared transition ${transition.revision}, but target is now at revision ${target.state.revision}`,
        'RESEARCH_STALE_WRITE',
      )
    }
    const openRun = await this.findOpenRun(session, id, signal)
    if (openRun !== undefined) {
      throw new ResearcherError(
        `research run ${openRun} opened before closed run ${run.id} could publish its state`,
        'RESEARCH_RUN_OPEN',
      )
    }
    const prospective: ResearchTargetSnapshot = {
      ...target,
      state: transition,
      latestRun: run,
    }
    assertContextFits(session, prospective, transition.at)
    const stateFile = await this.readVersioned(session, id, statePath(id), undefined, signal)
    const log = parseStateLog(stateFile.text)
    const current = log.states.at(-1)
    if (current === undefined) invalidRecord(`${statePath(id)} has no current state`)
    if (!isDeepStrictEqual(current, target.state)) {
      throw new ResearcherError(`${statePath(id)} changed while applying run ${run.id}`, 'RESEARCH_STALE_WRITE')
    }
    await this.replaceText(session, stateFile, statePath(id), appendStateText(log, transition), signal)
    return transition
  }

  async updateGlossary(
    session: Session,
    idInput: ResearchId | string,
    patch: ResearchGlossaryPatch,
    signal?: AbortSignal,
  ): Promise<ResearchGlossaryResult> {
    const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput
    return await this.mutex(session, id).run(async () => {
      if ((patch.terms === undefined || Object.keys(patch.terms).length === 0)
        && (patch.files === undefined || Object.keys(patch.files).length === 0)) {
        invalidRecord('glossary patch must contain at least one terms or files entry')
      }
      const file = await this.readVersioned(session, id, glossaryPath(id), RECORD_MAX_BYTES, signal)
      const current = parseJsonText(glossaryPath(id), file.text, researchGlossarySchema, RECORD_MAX_BYTES)
      const terms: Record<string, string> = { ...current.terms }
      const files: Record<string, string> = { ...current.files }
      for (const [key, value] of Object.entries(patch.terms ?? {})) {
        if (key.trim().length === 0) invalidRecord('glossary term keys must not be empty')
        if (value === null) delete terms[key]
        else if (value.trim().length === 0) invalidRecord(`glossary term ${JSON.stringify(key)} has an empty value`)
        else terms[key] = value
      }
      for (const [rawKey, value] of Object.entries(patch.files ?? {})) {
        const key = normalizeProjectRelativePath(rawKey)
        if (value === null) delete files[key]
        else if (value.trim().length === 0) invalidRecord(`glossary file ${JSON.stringify(key)} has an empty value`)
        else files[key] = value
      }
      const glossary = researchGlossarySchema.parse({ version: 1, terms, files })
      await this.validateGlossaryFiles(session, glossary, [], signal)
      const content = `${JSON.stringify(glossary, null, 2)}\n`
      if (Buffer.byteLength(content, 'utf8') > RECORD_MAX_BYTES) {
        throw new ResearcherError('glossary.json exceeds 64 KiB', 'RESEARCH_OVERSIZED')
      }
      await this.replaceText(session, file, glossaryPath(id), content, signal)
      return {
        researchId: id,
        path: glossaryPath(id),
        termCount: Object.keys(terms).length,
        fileCount: Object.keys(files).length,
      }
    })
  }

  async bindSession(session: Session, idInput: ResearchId | string, loadedAt: string, signal?: AbortSignal): Promise<void> {
    const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput
    await this.mutex(session, id).run(async () => {
      await this.ensureSessionIndex(session, id, signal, loadedAt)
    })
  }

  async materializeSession(session: Session, idInput: ResearchId | string, signal?: AbortSignal): Promise<void> {
    const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput
    await this.mutex(session, id).run(async () => {
      await this.ensureSessionIndex(session, id, signal)
    })
  }

  async readRun(
    session: Session,
    idInput: ResearchId | string,
    runIdInput: RunId | string,
    signal?: AbortSignal,
  ): Promise<ResearchRun> {
    const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput
    const runId = typeof runIdInput === 'string' ? parseRunId(runIdInput) : runIdInput
    const file = await this.readVersioned(session, id, runPath(id, runId), undefined, signal)
    return parseRunLog(runId, file.text)
  }

  private async ensureSessionIndex(
    session: Session,
    id: ResearchId,
    signal?: AbortSignal,
    explicitLoadedAt?: string,
  ): Promise<void> {
    const relative = sessionPath(id, String(session.id))
    const runIds = await this.rebuildSessionRunIds(session, id, String(session.id), signal)
    const target = await this.resolveAuthorityContained(session, id, relative, signal)
    const linkInfo = await this.ctx.fs.lstat(relative, { cwd: sessionCwd(session) }, signal)
    if (linkInfo !== undefined && linkInfo.type !== 'file') {
      throw new ResearcherError(`research session index is a symlink or non-file: ${relative}`, 'RESEARCH_PATH_INVALID')
    }
    const info = await this.ctx.fs.stat(target, signal)
    let loadedAt = explicitLoadedAt ?? nowIso()
    if (info !== undefined) {
      if (info.type !== 'file') invalidRecord(`${relative} is not a regular file`)
      if (info.size !== undefined && info.size > SESSION_INDEX_MAX_BYTES) {
        throw new ResearcherError(`${relative} exceeds 1 MiB`, 'RESEARCH_OVERSIZED')
      }
      const current = parseJsonText(relative, await this.ctx.fs.readText(target, signal), researchSessionIndexSchema, SESSION_INDEX_MAX_BYTES)
      if (current.sessionId !== String(session.id)) {
        invalidRecord(`${relative} sessionId does not match its reversible filename`)
      }
      loadedAt = explicitLoadedAt ?? current.loadedAt
    }
    const next = researchSessionIndexSchema.parse({
      version: 1,
      sessionId: String(session.id),
      loadedAt,
      runIds,
    })
    const content = `${JSON.stringify(next, null, 2)}\n`
    if (Buffer.byteLength(content, 'utf8') > SESSION_INDEX_MAX_BYTES) {
      throw new ResearcherError(`${relative} exceeds 1 MiB`, 'RESEARCH_OVERSIZED')
    }
    if (info === undefined) {
      await this.createText(session, relative, content, this.writePolicy(session), signal)
      return
    }
    await this.replaceText(session, { target, version: info.version }, relative, content, signal)
  }

  private async findPendingTransition(
    session: Session,
    id: ResearchId,
    currentRevision: number,
    signal?: AbortSignal,
  ): Promise<RunId | undefined> {
    const relative = `${targetRoot(id)}/runs`
    await this.assertRealDirectory(session, relative, signal)
    const directory = await this.resolveAuthorityContained(session, id, relative, signal)
    for (const entry of await this.ctx.fs.listDir(directory, signal)) {
      if (entry.type !== 'file' || !entry.name.endsWith('.jsonl')) continue
      let runId: RunId
      try {
        runId = parseRunId(entry.name.slice(0, -'.jsonl'.length))
      } catch {
        continue
      }
      const run = await this.readRun(session, id, runId, signal)
      if (run.result?.transition.revision === currentRevision + 1) return runId
    }
    return undefined
  }

  private async findOpenRun(session: Session, id: ResearchId, signal?: AbortSignal): Promise<RunId | undefined> {
    const relative = `${targetRoot(id)}/runs`
    await this.assertRealDirectory(session, relative, signal)
    const directory = await this.resolveAuthorityContained(session, id, relative, signal)
    let open: RunId | undefined
    for (const entry of await this.ctx.fs.listDir(directory, signal)) {
      if (entry.type !== 'file' || !entry.name.endsWith('.jsonl')) continue
      let runId: RunId
      try {
        runId = parseRunId(entry.name.slice(0, -'.jsonl'.length))
      } catch {
        continue
      }
      const run = await this.readRun(session, id, runId, signal)
      if (run.result !== undefined) continue
      if (open !== undefined) invalidRecord(`research target ${id} contains multiple open runs: ${open}, ${runId}`)
      open = runId
    }
    return open
  }

  private async rebuildSessionRunIds(
    session: Session,
    id: ResearchId,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<RunId[]> {
    const relative = `${targetRoot(id)}/runs`
    await this.assertRealDirectory(session, relative, signal)
    const directory = await this.resolveAuthorityContained(session, id, relative, signal)
    const info = await this.ctx.fs.stat(directory, signal)
    if (info?.type !== 'directory') invalidRecord(`${targetRoot(id)}/runs is not a directory`)
    const matches: { id: RunId; createdAt: string }[] = []
    for (const entry of await this.ctx.fs.listDir(directory, signal)) {
      if (entry.type !== 'file' || !entry.name.endsWith('.jsonl')) continue
      let runId: RunId
      try {
        runId = parseRunId(entry.name.slice(0, -'.jsonl'.length))
      } catch {
        continue
      }
      const run = await this.readRun(session, id, runId, signal)
      if (run.description.sessionId === sessionId) matches.push({ id: runId, createdAt: run.description.createdAt })
    }
    matches.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    return matches.map(match => match.id)
  }

  private async validateGlossaryFiles(
    session: Session,
    glossary: ResearchGlossary,
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const root = await this.workspaceTarget(session, signal)
    for (const relative of Object.keys(glossary.files).sort()) {
      const target = await this.ctx.fs.resolve(relative, pathOptions(session, signal))
      if (!this.ctx.fs.contains(root, target)) {
        throw new ResearcherError(`glossary file escapes the project root through its canonical target: ${relative}`, 'RESEARCH_PATH_INVALID')
      }
      const info = await this.ctx.fs.stat(target, signal)
      if (info === undefined) warnings.push(`glossary file is missing: ${relative}`)
    }
  }

  private normalizeArtifactPaths(artifacts: readonly string[]): string[] {
    const normalized: string[] = []
    const seen = new Set<string>()
    for (const raw of artifacts) {
      const relative = normalizeProjectRelativePath(raw)
      if (seen.has(relative)) invalidRecord(`duplicate artifact path: ${relative}`)
      seen.add(relative)
      normalized.push(relative)
    }
    return normalized
  }

  private async validateArtifacts(
    session: Session,
    artifacts: readonly string[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    const root = await this.workspaceTarget(session, signal)
    const normalized = this.normalizeArtifactPaths(artifacts)
    for (const relative of normalized) {
      const target = await this.ctx.fs.resolve(relative, pathOptions(session, signal))
      if (!this.ctx.fs.contains(root, target)) {
        throw new ResearcherError(`artifact escapes the project root through its canonical target: ${relative}`, 'RESEARCH_PATH_INVALID')
      }
      const info = await this.ctx.fs.stat(target, signal)
      if (info === undefined) invalidRecord(`artifact does not exist: ${relative}`)
    }
    return normalized
  }

  private shortError(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error)
    return text.length <= 180 ? text : `${text.slice(0, 179)}…`
  }
}
