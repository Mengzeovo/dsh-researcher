import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdtemp, open, readdir, readlink, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ResearcherError } from './errors.ts'
import { preparedPlanRunResultSchema, reproductionSchema } from './schema.ts'
import { createGitRunner, GIT_SAFETY_ARGS, gitEnvironment, type GitResult, type GitRunner } from './git-runtime.ts'

export interface ReproductionSpec {
  command: string
  cwd: string
  /** Descriptive lossless JSON only; NEVER passed to a subprocess. */
  environment: Readonly<Record<string, JsonValue>>
  inputs: readonly string[]
  /** Opt-in partial working-tree overlay. Omitted means historical all-tracked capture. */
  snapshot?: { mode: 'scoped'; paths: readonly string[]; externalInputs?: readonly ArtifactDigest[] | undefined; omitChanges?: readonly string[] | undefined } | undefined
}
export interface InputCheckpoint {
  backend: 'git'
  inputRef: string
  outputRef: string
  inputCommit: string
  inputTree: string
  baseHead: string
  objectFormat: 'sha1' | 'sha256'
  files: readonly string[]
  reproduction: ReproductionSpec
  snapshot?: { mode: 'scoped-overlay'; deleted: readonly string[]; omittedChanges: readonly string[] } | undefined
}
export interface ArtifactDigest { path: string; sha256: string; bytes: number }
export interface OutputCheckpoint {
  backend: 'git'
  inputCommit: string
  outputCommit: string
  inputTree: string
  outputTree: string
  inputRef: string
  outputRef: string
  objectFormat: 'sha1' | 'sha256'
  artifacts: readonly ArtifactDigest[]
  codeChanged: boolean
  snapshot?: { mode: 'scoped-overlay'; baseHead: string; deleted: readonly string[] } | undefined
}

export const CHECKPOINT_MAX_FILE_BYTES = 10 * 1024 * 1024
export const CHECKPOINT_MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024
export const CHECKPOINT_MAX_FILES = 2000
/** Artifacts are streamed, with a hard 1 GiB aggregate cap (also bounds each file). */
export const CHECKPOINT_MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024
export const CHECKPOINT_MAX_MESSAGE_BYTES = 64 * 1024
const MAX_GIT_OUTPUT = 2 * 1024 * 1024
const SECRET_CONTENT = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|PuTTY-User-Key-File-[0-9]+:/u
const REF = /^refs\/dsh\/research\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/runs\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/input$/u

type Stamp = { path: string; stat: BigIntStats | undefined }
type CapturedFile = Stamp & { bytes: Buffer; mode: string }
type Repo = { root: string; gitDir: string; policy: SandboxExecutionPolicy; format: 'sha1' | 'sha256'; signal?: AbortSignal }
type InputBody = Omit<InputCheckpoint, 'inputCommit'>
type OutputBody = Omit<OutputCheckpoint, 'outputCommit'>
type FinishResult = { checkpoint: OutputCheckpoint; prepared: Record<string, JsonValue> }

function invalid(message: string, cause?: unknown): never {
  throw new ResearcherError(message, 'RESEARCH_CHECKPOINT_INVALID', cause === undefined ? undefined : { cause })
}
function canceled(signal?: AbortSignal): void { signal?.throwIfAborted() }
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
function excluded(file: string): boolean {
  return file.split('/').some(part => ['.git', '.research'].includes(part.toLowerCase()))
}
function relativePath(value: unknown, allowDot = false): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\x00-\x1f\x7f\\:]/u.test(value)
    || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || value.split('/').some(part => part === '..' || part === '' || (!allowDot && part === '.'))
    || (!allowDot && value === '.')) invalid('checkpoint paths must be normalized project-relative paths')
  return value
}
function safeFile(value: unknown): string {
  const file = relativePath(value)
  if (excluded(file)) invalid(`checkpoint excludes Git and research metadata: ${file}`)
  for (const part of file.split('/')) {
    if (/^(?:\.env.*|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|ppk)|credentials(?:\..*)?)$/iu.test(part)) {
      invalid(`likely secret file cannot be checkpointed: ${file}`)
    }
  }
  return file
}
function decode(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch (error) { invalid('Git returned non-UTF-8 metadata or filenames', error) }
}
function oid(value: string, format: Repo['format']): string {
  if (!(format === 'sha1' ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(value)) invalid('invalid Git object id')
  return value
}
function jsonCopy<T>(value: T): T {
  const visit = (item: unknown, depth = 0): void => {
    if (depth > 100) invalid('checkpoint JSON is too deeply nested')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (Array.isArray(item)) { for (const entry of item) visit(entry, depth + 1); return }
    if (typeof item === 'object' && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
      for (const entry of Object.values(item)) visit(entry, depth + 1)
      return
    }
    invalid('checkpoint metadata must be lossless JSON')
  }
  visit(value)
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > CHECKPOINT_MAX_MESSAGE_BYTES) invalid('checkpoint metadata exceeds 64 KiB')
  return JSON.parse(text) as T
}
function message(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(jsonCopy(value))}\n`)
  if (bytes.length > CHECKPOINT_MAX_MESSAGE_BYTES) invalid('checkpoint commit message exceeds 64 KiB')
  return bytes
}
async function maybeStat(file: string): Promise<BigIntStats | undefined> {
  try { return await lstat(file, { bigint: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
function sameStat(a: BigIntStats | undefined, b: BigIntStats | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink
}

/**
 * Conservative host-local MVP. Node fs is used only for raw, bounded reads and a
 * private temporary index directory after policy/host-boundary checks. Every Git
 * process uses the DSH runtime. No reproduction command is ever executed.
 * Concurrent hostile filesystem mutation is not an OS transaction: no-follow
 * opens, component checks and prepublication stat verification fail closed on
 * observed races; callers must not deliberately swap repository metadata mid-call.
 */
export class GitCheckpointProvider {
  private readonly runner: GitRunner
  constructor(private readonly ctx: Context, runner?: GitRunner) { this.runner = runner ?? createGitRunner(ctx) }

  private async git(repo: Repo, args: readonly string[], stdin?: Buffer, env: NodeJS.ProcessEnv = {}): Promise<GitResult> {
    canceled(repo.signal)
    return await this.runner({
      argv: ['git', ...GIT_SAFETY_ARGS, `--git-dir=${repo.gitDir}`, `--work-tree=${repo.root}`, ...args],
      cwd: repo.root, env: gitEnvironment(env), policy: repo.policy, maxOutputBytes: MAX_GIT_OUTPUT,
      ...(stdin === undefined ? {} : { stdin }), ...(repo.signal === undefined ? {} : { signal: repo.signal }),
    })
  }
  private async ok(repo: Repo, args: readonly string[], stdin?: Buffer, env: NodeJS.ProcessEnv = {}): Promise<Buffer> {
    const result = await this.git(repo, args, stdin, env)
    if (result.exitCode !== 0) invalid(`Git ${args[0]} failed: ${decode(result.stderr).slice(0, 1200)}`)
    return result.stdout
  }

  /** Reject all metadata symlinks/special files, hardlinks and external object stores. */
  private async guardMetadata(gitDir: string): Promise<void> {
    let entries = 0
    const walk = async (directory: string): Promise<void> => {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) invalid('Git metadata must use real directories, not linked worktrees')
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++entries > 200_000) invalid('Git metadata is too large for the checkpoint MVP')
        const file = path.join(directory, entry.name)
        const stat = await lstat(file)
        if (entry.name.endsWith('.promisor')) invalid('partial-clone promisor object stores are unsupported')
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink > 1)) {
          invalid(`unsafe Git metadata link or special file: ${path.relative(gitDir, file)}`)
        }
        if (stat.isDirectory()) await walk(file)
      }
    }
    await walk(gitDir)
    for (const name of ['commondir', 'gitdir', 'objects/info/alternates', 'objects/info/http-alternates', 'info/grafts', 'shallow']) {
      if (await maybeStat(path.join(gitDir, name))) invalid(`unsupported external or rewritten Git metadata: ${name}`)
    }
    const configPath = path.join(gitDir, 'config')
    const config = await this.readRegular(configPath, 64 * 1024)
    const text = decode(config.bytes)
    // Reject includes BEFORE invoking any Git command (even setup may read config).
    // Continuations are deliberately unsupported so section/key checks cannot be obscured.
    if (/\\\r?\n/u.test(text) || /^\s*\[\s*include/imu.test(text)) invalid('Git config includes/continuations are unsupported')
    let section = ''
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim()
      if (trimmed === '' || /^[#;]/u.test(trimmed)) continue
      if (trimmed.startsWith('[')) {
        const matched = /^\[([a-zA-Z0-9.-]+)(?:\s+"[^"\r\n]*")?\]\s*(?:[#;].*)?$/u.exec(trimmed)
        if (!matched) invalid('unsupported Git config section syntax')
        section = matched[1]!.toLowerCase()
        if (section.startsWith('include')) invalid('Git config includes are unsupported')
      } else {
        const matched = /^([a-zA-Z][a-zA-Z0-9-]*)\s*(?:=\s*(.*))?$/u.exec(trimmed)
        if (!matched) invalid('unsupported Git config key syntax')
        const key = matched[1]!.toLowerCase()
        if (section === 'extensions' && key !== 'objectformat') invalid(`unsupported Git extension: ${key}`)
        if ((section === 'remote' || section.startsWith('remote.')) && (key === 'promisor' || key === 'partialclonefilter')) invalid('partial-clone remote configuration is unsupported')
        if (section === 'core' && (key === 'worktree' || key === 'gitdir'
          || (key === 'bare' && !/^false\s*(?:[#;].*)?$/iu.test(matched[2] ?? 'true')))) invalid('Git config redirects the workspace')
      }
    }
  }

  private async repo(session: Session, signal?: AbortSignal): Promise<Repo> {
    canceled(signal)
    if (process.platform === 'win32') invalid('Git checkpoint MVP requires a POSIX host')
    const policy = this.ctx.sandboxPolicy.resolve({ session })
    if (policy.mode === 'read-only') invalid('Git checkpoints cannot write while the session is read-only')
    const cwd = session.header.cwd
    if (cwd === undefined || !path.isAbsolute(cwd)) invalid('Git checkpoints require a host-local absolute workspace')
    const root = await realpath(cwd)
    if (!inside(await realpath(policy.workspaceRoot), root)) invalid('checkpoint workspace escapes sandbox policy root')
    const target = await this.ctx.fs.resolve(cwd, { ...(signal === undefined ? {} : { signal }) })
    if (this.ctx.fs.processPathFromHostPath(root) !== root || this.ctx.fs.processPath(target) !== root) {
      invalid('Git checkpoint MVP supports only host-local filesystem capabilities')
    }
    const gitDir = path.join(root, '.git')
    await this.guardMetadata(gitDir)
    const repo: Repo = { root, gitDir, policy, format: 'sha1', ...(signal === undefined ? {} : { signal }) }
    const top = decode(await this.ok(repo, ['rev-parse', '--show-toplevel'])).trimEnd()
    if (top !== root) invalid('workspace must equal the Git top-level')
    const format = decode(await this.ok(repo, ['rev-parse', '--show-object-format'])).trim()
    if (format !== 'sha1' && format !== 'sha256') invalid('unsupported Git object format')
    repo.format = format
    return repo
  }

  private async readRegular(file: string, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Buffer; stat: BigIntStats }> {
    canceled(signal)
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || before.size > BigInt(maxBytes)) invalid(`not a regular file or file exceeds hard size limit: ${file}`)
      const parts: Buffer[] = []
      let total = 0
      while (true) {
        canceled(signal)
        const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1))
        const { bytesRead } = await handle.read(buffer)
        if (bytesRead === 0) break
        total += bytesRead
        if (total > maxBytes) invalid(`file exceeds hard size limit: ${file}`)
        parts.push(buffer.subarray(0, bytesRead))
      }
      if (!sameStat(before, await handle.stat({ bigint: true })) || !sameStat(before, await maybeStat(file))) invalid(`file changed while reading: ${file}`)
      return { bytes: Buffer.concat(parts), stat: before }
    } finally { await handle.close() }
  }

  /** Ancestors, cwd and explicit inputs/artifacts remain no-follow; only tracked leaf links may be captured. */
  private async fileStat(repo: Repo, file: string, directory = false, allowLeafSymlink = false): Promise<BigIntStats | undefined> {
    const parts = relativePath(file, directory).split('/')
    if (file === '.' && directory) return await lstat(repo.root, { bigint: true })
    let current = repo.root
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]!)
      const stat = await maybeStat(current)
      if (stat === undefined) return undefined
      if (stat.isSymbolicLink()) {
        if (allowLeafSymlink && !directory && index === parts.length - 1) return stat
        invalid(`symlink checkpoint path is unsupported: ${file}`)
      }
      const isDirectory = index < parts.length - 1 || directory
      if (isDirectory) {
        if (!stat.isDirectory()) invalid(`checkpoint path ancestor is not a directory: ${file}`)
        if (await maybeStat(path.join(current, '.git')) || (await maybeStat(path.join(current, 'HEAD')) && await maybeStat(path.join(current, 'objects')))) {
          invalid(`nested repository input is unsupported: ${file}`)
        }
      } else if (!stat.isFile()) invalid(`checkpoint requires regular files: ${file}`)
      if (index === parts.length - 1) return stat
    }
    return undefined
  }

  private async verify(repo: Repo, stamps: readonly Stamp[]): Promise<void> {
    for (const stamp of stamps) {
      canceled(repo.signal)
      if (!sameStat(stamp.stat, await this.fileStat(repo, stamp.path, false, stamp.stat?.isSymbolicLink() === true))) invalid(`file changed before checkpoint publication: ${stamp.path}`)
    }
  }
  private async noMerge(repo: Repo): Promise<void> {
    if (await maybeStat(path.join(repo.gitDir, 'MERGE_HEAD'))) invalid('unresolved or uncommitted merge is unsupported')
    if ((await this.ok(repo, ['ls-files', '--unmerged', '-z'])).length !== 0) invalid('unresolved index merge is unsupported')
  }
  private async tracked(repo: Repo, base: string, scopes?: readonly string[]): Promise<string[]> {
    const names = new Set<string>()
    const add = (mode: string, file: string): void => {
      if (mode === '160000') invalid('Git submodules are unsupported')
      if (excluded(file) || (scopes && !this.inScope(file, scopes))) return
      safeFile(file)
      if (mode !== '100644' && mode !== '100755' && mode !== '120000') invalid(`unsupported tracked entry mode: ${file}`)
      names.add(file)
    }
    for (const entry of decode(await this.ok(repo, ['ls-files', '--stage', '-z'])).split('\0').filter(Boolean)) {
      const match = /^(\d{6}) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/u.exec(entry)
      if (!match || match[3] !== '0') invalid('unresolved or malformed Git index')
      add(match[1]!, match[4]!)
    }
    for (const entry of decode(await this.ok(repo, ['ls-tree', '-r', '-z', base])).split('\0').filter(Boolean)) {
      const match = /^(\d{6}) \w+ [a-f0-9]+\t([\s\S]+)$/u.exec(entry)
      if (!match) invalid('malformed Git base tree')
      add(match[1]!, match[2]!)
    }
    return [...names]
  }
  /** Capture link text, never target contents. Only relative targets lexically inside the workspace are accepted. */
  private async readTrackedSymlink(repo: Repo, file: string, stat: BigIntStats): Promise<{ bytes: Buffer; stat: BigIntStats }> {
    canceled(repo.signal)
    const absolute = path.join(repo.root, file)
    const bytes = await readlink(absolute, { encoding: 'buffer' })
    if (bytes.length > CHECKPOINT_MAX_FILE_BYTES || !sameStat(stat, await maybeStat(absolute))) {
      invalid(`symlink changed while reading or exceeds size limit: ${file}`)
    }
    this.validateLinkTarget(repo, file, bytes)
    return { bytes, stat }
  }
  private validateLinkTarget(repo: Repo, file: string, bytes: Buffer): void {
    const target = decode(bytes)
    const resolved = path.resolve(repo.root, path.dirname(file), target)
    if (!target || path.isAbsolute(target) || !inside(repo.root, resolved)) invalid(`unsafe tracked symlink target: ${file}`)
    safeFile(path.relative(repo.root, resolved))
  }

  private async capture(repo: Repo, files: readonly string[], required: ReadonlySet<string>, regularOnly: ReadonlySet<string> = required): Promise<{ entries: CapturedFile[]; stamps: Stamp[] }> {
    if (files.length > CHECKPOINT_MAX_FILES) invalid('checkpoint exceeds 2000 file limit')
    let bytes = 0
    const entries: CapturedFile[] = []
    const stamps: Stamp[] = []
    for (const file of files) {
      safeFile(file)
      const stat = await this.fileStat(repo, file, false, !regularOnly.has(file))
      if (stat === undefined) {
        if (required.has(file)) invalid(`explicit input file is missing: ${file}`)
        stamps.push({ path: file, stat: undefined })
        continue
      }
      const captured = stat.isSymbolicLink()
        ? await this.readTrackedSymlink(repo, file, stat)
        : await this.readRegular(path.join(repo.root, file), CHECKPOINT_MAX_FILE_BYTES, repo.signal)
      if (!sameStat(stat, captured.stat)) invalid(`file changed before checkpoint read: ${file}`)
      if (SECRET_CONTENT.test(captured.bytes.toString('latin1'))) invalid(`private key content cannot be checkpointed: ${file}`)
      bytes += captured.bytes.length
      if (bytes > CHECKPOINT_MAX_SNAPSHOT_BYTES) invalid('checkpoint exceeds 50 MiB snapshot limit')
      const stamp = { path: file, stat: captured.stat }
      stamps.push(stamp)
      entries.push({ ...stamp, bytes: captured.bytes, mode: captured.stat.isSymbolicLink() ? '120000' : (captured.stat.mode & 0o111n) !== 0n ? '100755' : '100644' })
    }
    return { entries, stamps }
  }
  private inScope(file: string, scopes: readonly string[]): boolean {
    return scopes.some(scope => file === scope || file.startsWith(scope + '/'))
  }

  /** Enumerate names only outside the opt-in scope, never working-file contents. */
  private async scopedInventory(repo: Repo, baseHead: string, repro: ReproductionSpec, frozenFiles: readonly string[] = []): Promise<{ files: string[]; omittedChanges: string[] }> {
    const spec = repro.snapshot!
    const scopes = spec.paths.map(safeFile)
    const external = new Set((spec.externalInputs ?? []).map(item => safeFile(item.path)))
    const explicit = new Set(repro.inputs.map(safeFile))
    const tracked = await this.tracked(repo, baseHead, scopes)
    const selected = new Set([...tracked.filter(file => !external.has(file)), ...explicit])
    const declared = new Set([...selected, ...external])
    for (const scope of scopes) {
      const stat = await maybeStat(path.join(repo.root, scope))
      await this.fileStat(repo, scope, stat?.isDirectory() === true, true)
      if (![...declared, ...frozenFiles].some(file => this.inScope(file, [scope]))) invalid(`scope matches no declared tracked/input files: ${scope}`)
    }
    const untracked = decode(await this.ok(repo, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...scopes.map(scope => ':(literal)' + scope)])).split('\0').filter(Boolean)
    for (const file of untracked) {
      if (!excluded(file) && !declared.has(file)) invalid(`untracked scoped file must be declared in reproduction.inputs or externalInputs: ${file}`)
    }
    const changed = decode(await this.ok(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', baseHead, '--'])).split('\0').filter(Boolean)
    const omittedChanges = [...new Set(changed.filter(file => !excluded(file) && !declared.has(file)).map(file => relativePath(file)))].sort()
    if (omittedChanges.length > CHECKPOINT_MAX_FILES) invalid('too many omitted tracked changes to report within checkpoint limits')
    const acknowledged = [...(spec.omitChanges ?? [])].map(safeFile).sort()
    if (!isDeepStrictEqual(acknowledged, omittedChanges)) invalid('outside-scope tracked changes require an exact snapshot.omitChanges acknowledgement: ' + JSON.stringify(omittedChanges))
    return { files: [...selected].sort(), omittedChanges }
  }

  /** Retained data are checked by streaming, not stored in the code tree. */
  private async externalInputs(repo: Repo, repro: ReproductionSpec): Promise<Stamp[]> {
    const expected = repro.snapshot?.externalInputs ?? []
    const actual = await this.artifacts(repo, expected.map(item => item.path))
    if (!isDeepStrictEqual(actual.artifacts, expected)) invalid('external input size or SHA-256 mismatch; no checkpoint published')
    return actual.stamps
  }

  private async tree(repo: Repo, entries: readonly CapturedFile[]): Promise<string> {
    // mkdtemp is the only direct filesystem write; gated by repo() and confined root.
    const temp = await mkdtemp(path.join(repo.gitDir, 'dsh-index-'))
    const env = { GIT_INDEX_FILE: path.join(temp, 'index') }
    try {
      const records: Buffer[] = []
      for (const entry of entries) {
        const hash = oid(decode(await this.ok(repo, ['hash-object', '-w', '--no-filters', '--stdin'], entry.bytes)).trim(), repo.format)
        records.push(Buffer.from(`${entry.mode} ${hash}\t${entry.path}\0`))
      }
      await this.ok(repo, ['read-tree', '--empty'], undefined, env)
      await this.ok(repo, ['update-index', '-z', '--index-info'], Buffer.concat(records), env)
      return oid(decode(await this.ok(repo, ['write-tree'], undefined, env)).trim(), repo.format)
    } finally { await rm(temp, { recursive: true, force: true }) }
  }
  private async commit(repo: Repo, tree: string, parent: string, body: Buffer, timestamp: string): Promise<string> {
    if (!Number.isFinite(Date.parse(timestamp))) invalid('checkpoint timestamp must be a valid date')
    return oid(decode(await this.ok(repo, ['commit-tree', tree, '-p', parent], body, {
      GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp,
    })).trim(), repo.format)
  }
  private async ref(repo: Repo, ref: string): Promise<string | undefined> {
    // symbolic refs would turn a write into an update of another namespace.
    const symbolic = await this.git(repo, ['symbolic-ref', '-q', ref])
    if (symbolic.exitCode === 0) invalid('checkpoint refs must not be symbolic refs')
    if (symbolic.exitCode !== 1) invalid('cannot validate checkpoint ref type')
    const result = await this.git(repo, ['rev-parse', '--verify', '--quiet', ref])
    if (result.exitCode === 1) return undefined
    if (result.exitCode !== 0) invalid('cannot resolve checkpoint ref')
    return oid(decode(result.stdout).trim(), repo.format)
  }
  private async publish(repo: Repo, ref: string, commit: string, stamps: readonly Stamp[]): Promise<boolean> {
    await this.guardMetadata(repo.gitDir)
    // Recheck AFTER the potentially lengthy metadata walk, immediately before CAS.
    await this.verify(repo, stamps)
    const result = await this.git(repo, ['update-ref', '--no-deref', ref, commit, '0'.repeat(repo.format === 'sha1' ? 40 : 64)])
    const actual = await this.ref(repo, ref)
    if (result.exitCode === 0 && actual === commit) return true
    if (actual !== undefined) return false
    invalid(`cannot publish immutable checkpoint ref: ${decode(result.stderr).slice(0, 1200)}`)
  }
  private async readCommit(repo: Repo, commit: string): Promise<{ tree: string; parents: string[]; body: unknown }> {
    oid(commit, repo.format)
    const bytes = await this.ok(repo, ['cat-file', 'commit', commit])
    const separator = bytes.indexOf('\n\n')
    if (separator < 0 || bytes.length - separator - 2 > CHECKPOINT_MAX_MESSAGE_BYTES) invalid('invalid checkpoint commit message')
    const headers = decode(bytes.subarray(0, separator)).split('\n')
    const tree = oid(headers[0]?.replace(/^tree /u, '') ?? '', repo.format)
    const parents = headers.filter(line => line.startsWith('parent ')).map(line => oid(line.slice(7), repo.format))
    let body: unknown
    try { body = JSON.parse(decode(bytes.subarray(separator + 2))) } catch (error) { invalid('checkpoint commit is not an immutable JSON journal', error) }
    return { tree, parents, body }
  }
  private inputBody(input: InputCheckpoint): InputBody {
    const { inputCommit: _commit, ...body } = input
    return body
  }
  private async validateOverlayTree(repo: Repo, tree: string, files: readonly string[], deleted: readonly string[], explicit: readonly string[]): Promise<void> {
    const rows = decode(await this.ok(repo, ['ls-tree', '-r', '-l', '-z', tree])).split('\0').filter(Boolean)
    const names: string[] = []
    let totalBytes = 0
    for (const row of rows) {
      const entry = /^([0-7]+) (\S+) ([0-9a-f]+) +([0-9]+|-)\t(.+)$/u.exec(row)
      if (!entry || entry[2] !== 'blob' || !['100644', '100755', '120000'].includes(entry[1]!)) invalid('unsupported overlay entry mode/type')
      const file = safeFile(entry[5]!)
      const bytes = Number(entry[4])
      totalBytes += bytes
      if (!Number.isSafeInteger(bytes) || bytes > CHECKPOINT_MAX_FILE_BYTES || totalBytes > CHECKPOINT_MAX_SNAPSHOT_BYTES || names.length >= CHECKPOINT_MAX_FILES) invalid('overlay tree exceeds snapshot limits')
      if (entry[1] === '120000') {
        if (explicit.includes(file)) invalid('explicit input cannot be a symlink in an overlay')
        this.validateLinkTarget(repo, file, await this.ok(repo, ['cat-file', 'blob', entry[3]!]))
      }
      names.push(file)
    }
    const expectedDeleted = files.filter(file => !names.includes(file)).sort()
    if (names.some(file => !files.includes(file)) || !isDeepStrictEqual([...deleted].sort(), expectedDeleted)) invalid('overlay tree and deletion manifest disagree')
  }

  private async validateInput(repo: Repo, input: InputCheckpoint): Promise<void> {
    const match = REF.exec(input.inputRef)
    if (!match || input.outputRef !== input.inputRef.replace(/\/input$/u, '/output') || input.backend !== 'git' || input.objectFormat !== repo.format) invalid('invalid checkpoint input identity')
    for (const value of [input.inputCommit, input.inputTree, input.baseHead]) oid(value, repo.format)
    if (await this.ref(repo, input.inputRef) !== input.inputCommit) invalid('immutable input checkpoint ref no longer matches run')
    const stored = await this.readCommit(repo, input.inputCommit)
    if (stored.tree !== input.inputTree || !isDeepStrictEqual(stored.parents, [input.baseHead])
      || !isDeepStrictEqual(stored.body, { version: input.snapshot ? 2 : 1, type: 'dsh-research-input', checkpoint: this.inputBody(input) })) invalid('input checkpoint journal does not match run identity')
    if ((input.snapshot !== undefined) !== (input.reproduction.snapshot !== undefined)) invalid('scoped input marker and recipe disagree')
    if (input.snapshot) {
      if (input.snapshot.mode !== 'scoped-overlay') invalid('invalid scoped input marker')
      await this.validateOverlayTree(repo, input.inputTree, input.files, input.snapshot.deleted, input.reproduction.inputs)
    }
  }
  private async recover(repo: Repo, input: InputCheckpoint, requestKey: string): Promise<FinishResult | undefined> {
    const commit = await this.ref(repo, input.outputRef)
    if (commit === undefined) return undefined
    const stored = await this.readCommit(repo, commit)
    const body = jsonCopy(stored.body) as { version?: unknown; type?: unknown; requestKey?: unknown; checkpoint?: OutputBody; prepared?: Record<string, JsonValue> } | null
    if (body === null || typeof body !== 'object' || (body.version !== 1 && body.version !== 2 && body.version !== 3) || body.type !== 'dsh-research-output'
      || body.requestKey !== requestKey || !body.checkpoint || !body.prepared) invalid('output checkpoint request conflicts with immutable journal')
    if ((body.version === 1 && body.prepared.version !== 1) || ((body.version === 2 || body.version === 3) && body.prepared.version !== 3)
      || (body.version === 3) !== (input.snapshot !== undefined)) {
      invalid('output checkpoint journal version does not match its prepared result')
    }
    const cp = body.checkpoint
    if (cp.backend !== 'git' || cp.inputCommit !== input.inputCommit || cp.inputTree !== input.inputTree
      || cp.inputRef !== input.inputRef || cp.outputRef !== input.outputRef || cp.objectFormat !== repo.format
      || cp.outputTree !== stored.tree || cp.codeChanged !== (stored.tree !== input.inputTree)
      || 'outputCommit' in cp || !isDeepStrictEqual(stored.parents, [input.inputCommit])) invalid('output checkpoint journal identity mismatch')
    if ((cp.snapshot !== undefined) !== (input.snapshot !== undefined)
      || (cp.snapshot && (cp.snapshot.mode !== 'scoped-overlay' || cp.snapshot.baseHead !== input.baseHead
        || !Array.isArray(cp.snapshot.deleted) || cp.snapshot.deleted.some(file => !input.files.includes(file))
        || new Set(cp.snapshot.deleted).size !== cp.snapshot.deleted.length))) invalid('scoped output overlay identity mismatch')
    if (cp.snapshot) await this.validateOverlayTree(repo, cp.outputTree, input.files, cp.snapshot.deleted, input.reproduction.inputs)
    this.validatePrepared(body.prepared)
    if (!Array.isArray(cp.artifacts) || cp.artifacts.length !== (body.prepared.artifacts as string[]).length) invalid('invalid artifact journal')
    cp.artifacts.forEach((artifact, index) => {
      if (artifact.path !== (body.prepared!.artifacts as string[])[index] || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
        || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > CHECKPOINT_MAX_ARTIFACT_BYTES) invalid('invalid artifact digest journal')
      safeFile(artifact.path)
    })
    return { checkpoint: { ...cp, outputCommit: commit }, prepared: body.prepared }
  }
  private validatePrepared(prepared: Record<string, JsonValue>): void {
    if (prepared.version === 3) {
      const parsed = preparedPlanRunResultSchema.safeParse(prepared)
      if (!parsed.success) invalid('checkpoint requires the complete prepared plan result without a checkpoint', parsed.error)
      return
    }
    // Keep historical provider validation unchanged; the coordinator validates
    // legacy run/state records without rewriting an already-sealed transition.
    if (prepared.version !== 1 || prepared.type !== 'result' || typeof prepared.finishedAt !== 'string'
      || !Number.isFinite(Date.parse(prepared.finishedAt)) || (prepared.status !== 'completed' && prepared.status !== 'failed')
      || typeof prepared.result !== 'string' || typeof prepared.decision !== 'string'
      || prepared.metrics === null || typeof prepared.metrics !== 'object' || Array.isArray(prepared.metrics)
      || prepared.transition === null || typeof prepared.transition !== 'object' || Array.isArray(prepared.transition)
      || !Array.isArray(prepared.artifacts) || prepared.artifacts.length > CHECKPOINT_MAX_FILES
      || !prepared.artifacts.every(file => typeof file === 'string')) invalid('checkpoint requires the complete prepared legacy result')
  }

  async start(session: Session, researchId: string, runId: string, createdAt: string, reproduction: ReproductionSpec, signal?: AbortSignal, validate?: (checkpoint: InputCheckpoint) => void): Promise<InputCheckpoint> {
    try {
      const repo = await this.repo(session, signal)
      const inputRef = `refs/dsh/research/${researchId}/runs/${runId}/input`
      if (!REF.test(inputRef)) invalid('invalid research/run checkpoint ref identity')
      if (await this.ref(repo, inputRef) !== undefined) invalid('input ref already pinned; start cannot be retried (an unpublished run may leave an orphan)')
      const outputRef = inputRef.replace(/\/input$/u, '/output')
      if (await this.ref(repo, outputRef) !== undefined) invalid('output ref already exists for new run')
      const repro = jsonCopy(reproduction)
      const checked = reproductionSchema.safeParse(repro)
      if (!checked.success) invalid('invalid reproduction specification: ' + checked.error.message, checked.error)
      if (typeof repro.command !== 'string' || !repro.command.trim() || !Array.isArray(repro.inputs)
        || repro.environment === null || typeof repro.environment !== 'object' || Array.isArray(repro.environment)) invalid('invalid reproduction specification')
      const cwd = relativePath(repro.cwd, true)
      if (excluded(cwd) || await this.fileStat(repo, cwd, true) === undefined) invalid('reproduction cwd must be an existing safe project directory')
      const explicit = new Set(repro.inputs.map(safeFile))
      await this.noMerge(repo)
      const baseHead = oid(decode(await this.ok(repo, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim(), repo.format)
      const inventory = repro.snapshot ? await this.scopedInventory(repo, baseHead, repro) : undefined
      const files = inventory?.files ?? [...new Set([...(await this.tracked(repo, baseHead)), ...explicit])].sort()
      const captured = await this.capture(repo, files, explicit)
      const dataStamps = await this.externalInputs(repo, repro)
      const stamps = [...captured.stamps, ...dataStamps]
      const inputTree = await this.tree(repo, captured.entries)
      const body: InputBody = { backend: 'git', inputRef, outputRef, inputTree, baseHead, objectFormat: repo.format, files, reproduction: repro,
        ...(inventory ? { snapshot: { mode: 'scoped-overlay', deleted: captured.stamps.filter(item => item.stat === undefined).map(item => item.path), omittedChanges: inventory.omittedChanges } } : {}),
      }
      const inputCommit = await this.commit(repo, inputTree, baseHead, message({ version: inventory ? 2 : 1, type: 'dsh-research-input', checkpoint: body }), createdAt)
      validate?.(jsonCopy({ ...body, inputCommit }))
      await this.verify(repo, stamps)
      await this.noMerge(repo)
      if (!await this.publish(repo, inputRef, inputCommit, stamps)) invalid('input ref publication conflicted; start cannot be retried with this run id')
      return { ...body, inputCommit }
    } catch (error) {
      if (error instanceof ResearcherError) throw error
      invalid('Git input checkpoint failed; no run was executed', error)
    }
  }

  private async artifacts(repo: Repo, paths: readonly string[]): Promise<{ artifacts: ArtifactDigest[]; stamps: Stamp[] }> {
    const artifacts: ArtifactDigest[] = []
    const stamps: Stamp[] = []
    let total = 0
    for (const name of paths) {
      const file = safeFile(name)
      const stat = await this.fileStat(repo, file)
      if (!stat) invalid(`artifact must be an existing regular file: ${file}`)
      if (stat.size > BigInt(CHECKPOINT_MAX_ARTIFACT_BYTES - total)) invalid('artifacts exceed 1 GiB aggregate limit')
      const handle = await open(path.join(repo.root, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        if (!sameStat(stat, await handle.stat({ bigint: true }))) invalid(`artifact changed before hashing: ${file}`)
        const hash = createHash('sha256')
        const buffer = Buffer.alloc(1024 * 1024)
        let bytes = 0
        while (true) {
          canceled(repo.signal)
          const { bytesRead } = await handle.read(buffer)
          if (bytesRead === 0) break
          bytes += bytesRead
          total += bytesRead
          if (total > CHECKPOINT_MAX_ARTIFACT_BYTES) invalid('artifacts exceed 1 GiB aggregate limit')
          hash.update(buffer.subarray(0, bytesRead))
        }
        if (!sameStat(stat, await handle.stat({ bigint: true })) || !sameStat(stat, await this.fileStat(repo, file)) || BigInt(bytes) !== stat.size) invalid(`artifact changed while hashing: ${file}`)
        artifacts.push({ path: file, sha256: hash.digest('hex'), bytes })
        stamps.push({ path: file, stat })
      } finally { await handle.close() }
    }
    return { artifacts, stamps }
  }

  async finish(session: Session, input: InputCheckpoint, requestKey: string, prepared: Record<string, JsonValue>, signal?: AbortSignal, validate?: (value: FinishResult) => void, beforeCapture?: () => Promise<void>): Promise<FinishResult> {
    try {
      const repo = await this.repo(session, signal)
      const frozenInput = jsonCopy(input)
      await this.validateInput(repo, frozenInput)
      if (typeof requestKey !== 'string' || !requestKey || Buffer.byteLength(requestKey) > 4096) invalid('invalid checkpoint request key')
      const existing = await this.recover(repo, frozenInput, requestKey)
      if (existing !== undefined) {
        validate?.(existing)
        return existing // Do not inspect current files/artifacts or new prepared timestamps.
      }
      const original = jsonCopy(prepared)
      this.validatePrepared(original)
      // Only the first seal revalidates external plan bytes. Journal replay must
      // remain possible after those bytes or artifact files are lost or changed.
      await beforeCapture?.()
      await this.noMerge(repo)
      if (frozenInput.snapshot) {
        if (original.version !== 3) invalid('scoped snapshots require a plan-bound v3 result')
        const inventory = await this.scopedInventory(repo, frozenInput.baseHead, frozenInput.reproduction, frozenInput.files)
        if (inventory.files.some(file => !frozenInput.files.includes(file))) invalid('new scoped source file is outside the frozen input set; declare it before execution')
      }
      const dataStamps = await this.externalInputs(repo, frozenInput.reproduction)
      // Deleted explicit files may be recorded, but they may not become symlinks at finish.
      const captured = await this.capture(repo, frozenInput.files, new Set(), new Set(frozenInput.reproduction.inputs))
      const outputTree = await this.tree(repo, captured.entries)
      const digests = await this.artifacts(repo, original.artifacts as string[])
      const body: OutputBody = {
        backend: 'git', inputCommit: frozenInput.inputCommit, inputTree: frozenInput.inputTree, outputTree,
        inputRef: frozenInput.inputRef, outputRef: frozenInput.outputRef, objectFormat: repo.format,
        artifacts: digests.artifacts, codeChanged: outputTree !== frozenInput.inputTree,
        ...(frozenInput.snapshot ? { snapshot: { mode: 'scoped-overlay', baseHead: frozenInput.baseHead, deleted: captured.stamps.filter(item => item.stat === undefined).map(item => item.path) } } : {}),
      }
      const outputCommit = await this.commit(repo, outputTree, frozenInput.inputCommit,
        message({ version: frozenInput.snapshot ? 3 : original.version === 3 ? 2 : 1, type: 'dsh-research-output', requestKey, prepared: original, checkpoint: body }), original.finishedAt as string)
      validate?.(jsonCopy({ checkpoint: { ...body, outputCommit }, prepared: original }))
      await this.verify(repo, [...captured.stamps, ...digests.stamps, ...dataStamps])
      await this.noMerge(repo)
      // A failed CAS is recoverable ONLY by validating the winner's complete immutable journal.
      await this.publish(repo, frozenInput.outputRef, outputCommit, [...captured.stamps, ...digests.stamps, ...dataStamps])
      const result = await this.recover(repo, frozenInput, requestKey)
      if (result === undefined) invalid('output ref was not published')
      validate?.(result)
      return result
    } catch (error) {
      if (error instanceof ResearcherError) throw error
      invalid('Git checkpoint publication failed; retry finish without rerunning the experiment', error)
    }
  }
}
