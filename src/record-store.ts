import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { FsError, type FsTarget, type FsVersion } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import { commitResearchDirectory, discardResearchStaging, ensureResearchDirectories } from './directories.ts'
import { ResearcherError, invalidRecord } from './errors.ts'
import { parseRunLog, parseStateLog, type ParsedStateLog } from './jsonl.ts'
import { RECORD_MAX_BYTES, SESSION_INDEX_MAX_BYTES, encodeSessionId, parseGoalMarkdown, parseJsonText, researchGlossarySchema, researchSessionIndexSchema } from './schema.ts'
import type { ResearchGlossary, ResearchId, ResearchRun, ResearchSessionIndex, RunId } from './types.ts'

export interface VersionedText {
  readonly relativePath: string
  readonly target: FsTarget
  readonly version: FsVersion
  readonly text: string
}

/** The parsed value and the exact observation used for a subsequent conditional replacement. */
export interface ObservedRecord<T> extends VersionedText {
  readonly value: T
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


export function targetRoot(id: ResearchId): string {
  return `.research/goal/${id}`
}

export function statePath(id: ResearchId): string {
  return `${targetRoot(id)}/state.jsonl`
}

export function glossaryPath(id: ResearchId): string {
  return `${targetRoot(id)}/glossary.json`
}

export function runPath(id: ResearchId, runId: RunId): string {
  return `${targetRoot(id)}/runs/${runId}.jsonl`
}

export function sessionPath(id: ResearchId, sessionId: string): string {
  return `${targetRoot(id)}/session/${encodeSessionId(sessionId)}.json`
}


function mapWriteError(error: unknown, subject: string): never {
  if (error instanceof FsError && (error.code === 'FS_STALE_VERSION' || error.code === 'FS_NOT_OBSERVED')) {
    throw new ResearcherError(`${subject} changed concurrently; reload and retry`, 'RESEARCH_STALE_WRITE', { cause: error })
  }
  throw error
}


/** Safe project-record I/O. No operation locks, research lifecycle, Goal, context or Git execution. */
export class RecordStore {
  constructor(private readonly ctx: Context) {}

  async canonicalWorkspace(session: Session): Promise<string> {
    return await realpath(sessionCwd(session))
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

  async assertRealDirectory(session: Session, relative: string, signal?: AbortSignal): Promise<void> {
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
    return { relativePath: relative, target, version: info.version, text }
  }

  private async readStream(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const stream = await this.ctx.fs.streamText(target, signal)
    let text = ''
    for await (const chunk of stream) text += chunk
    return text
  }

  writePolicy(session: Session): SandboxExecutionPolicy {
    const policy = this.ctx.sandboxPolicy.resolve({ session })
    if (policy.mode === 'read-only') {
      throw new ResearcherError('research project records cannot be changed while the session is read-only', 'RESEARCH_PATH_INVALID')
    }
    return policy
  }

  async createText(
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

  async replaceText(
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

  async readGoal(session: Session, id: ResearchId, signal?: AbortSignal): Promise<ObservedRecord<ReturnType<typeof parseGoalMarkdown>>> {
    const file = await this.readVersioned(session, id, `${targetRoot(id)}/goal.md`, RECORD_MAX_BYTES, signal)
    return { ...file, value: parseGoalMarkdown(file.text) }
  }

  async readStateLog(session: Session, id: ResearchId, signal?: AbortSignal): Promise<ObservedRecord<ParsedStateLog>> {
    const file = await this.readVersioned(session, id, statePath(id), undefined, signal)
    return { ...file, value: parseStateLog(file.text) }
  }

  async readGlossary(session: Session, id: ResearchId, signal?: AbortSignal): Promise<ObservedRecord<ResearchGlossary>> {
    const file = await this.readVersioned(session, id, glossaryPath(id), RECORD_MAX_BYTES, signal)
    return { ...file, value: parseJsonText(file.relativePath, file.text, researchGlossarySchema, RECORD_MAX_BYTES) }
  }

  async readRun(session: Session, id: ResearchId, runId: RunId, signal?: AbortSignal): Promise<ObservedRecord<ResearchRun>> {
    const file = await this.readVersioned(session, id, runPath(id, runId), undefined, signal)
    const run = parseRunLog(runId, file.text)
    if (run.description.version === 2) {
      const expected = 'refs/dsh/research/' + id + '/runs/' + run.id
      if (run.description.checkpoint.inputRef !== expected + '/input'
        || run.description.checkpoint.outputRef !== expected + '/output') {
        invalidRecord('run checkpoint refs belong to a different research target')
      }
    }
    return { ...file, value: run }
  }

  async readSessionIndex(session: Session, id: ResearchId, signal?: AbortSignal): Promise<ObservedRecord<ResearchSessionIndex> | undefined> {
    const relative = sessionPath(id, String(session.id))
    const target = await this.resolveAuthorityContained(session, id, relative, signal)
    const linkInfo = await this.ctx.fs.lstat(relative, { cwd: sessionCwd(session) }, signal)
    if (linkInfo !== undefined && linkInfo.type !== 'file') {
      throw new ResearcherError(`research session index is a symlink or non-file: ${relative}`, 'RESEARCH_PATH_INVALID')
    }
    const info = await this.ctx.fs.stat(target, signal)
    if (info === undefined) return undefined
    if (info.type !== 'file') invalidRecord(`${relative} is not a regular file`)
    if (info.size !== undefined && info.size > SESSION_INDEX_MAX_BYTES) {
      throw new ResearcherError(`${relative} exceeds 1 MiB`, 'RESEARCH_OVERSIZED')
    }
    const text = await this.ctx.fs.readText(target, signal)
    const value = parseJsonText(relative, text, researchSessionIndexSchema, SESSION_INDEX_MAX_BYTES)
    if (value.sessionId !== String(session.id)) {
      invalidRecord(`${relative} sessionId does not match its reversible filename`)
    }
    return { relativePath: relative, target, version: info.version, text, value }
  }

  async listTargetEntries(session: Session, signal?: AbortSignal) {
    const root = await this.resolveContained(session, '.research/goal', signal)
    const info = await this.ctx.fs.stat(root, signal)
    if (info === undefined) return []
    if (info.type !== 'directory') {
      throw new ResearcherError('.research/goal is not a directory', 'RESEARCH_PATH_INVALID')
    }
    await this.assertRealDirectory(session, '.research', signal)
    await this.assertRealDirectory(session, '.research/goal', signal)
    return await this.ctx.fs.listDir(root, signal)
  }

  async listRunEntries(session: Session, id: ResearchId, signal?: AbortSignal, verifyDirectory = false) {
    const directory = await this.resolveAuthorityContained(session, id, `${targetRoot(id)}/runs`, signal)
    if (verifyDirectory) {
      const info = await this.ctx.fs.stat(directory, signal)
      if (info?.type !== 'directory') invalidRecord(`${targetRoot(id)}/runs is not a directory`)
    }
    return await this.ctx.fs.listDir(directory, signal)
  }

  /** Project references intentionally do not inherit authority-record symlink/type restrictions. */
  async projectPathInspector(session: Session, signal?: AbortSignal) {
    const root = await this.workspaceTarget(session, signal)
    return async (relative: string) => {
      const target = await this.ctx.fs.resolve(relative, pathOptions(session, signal))
      if (!this.ctx.fs.contains(root, target)) return { contained: false as const, info: undefined }
      return { contained: true as const, info: await this.ctx.fs.stat(target, signal) }
    }
  }

  async ensureDirectories(session: Session, relatives: readonly string[]): Promise<SandboxExecutionPolicy> {
    return await ensureResearchDirectories(this.ctx, session, relatives)
  }

  async commitDirectory(session: Session, stagingRelative: string, finalRelative: string): Promise<void> {
    await commitResearchDirectory(this.ctx, session, stagingRelative, finalRelative)
  }

  async discardStaging(session: Session, stagingRelative: string): Promise<void> {
    await discardResearchStaging(this.ctx, session, stagingRelative)
  }
}
