import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHECKPOINT_MAX_FILE_BYTES, GitCheckpointProvider, type InputCheckpoint, type ReproductionSpec } from '../src/checkpoint.ts'
import { createGitRunner, gitEnvironment, type GitCommand, type GitResult, type GitRunner } from '../src/git-runtime.ts'
import { makeWorkspace, removeWorkspace, testContext, testSession } from './helpers.ts'

const at = '2026-09-05T00:00:00.000Z'
const reproduction = (inputs: string[] = []): ReproductionSpec => ({ command: 'do-not-run --example', cwd: '.', environment: { python: '3.12' }, inputs })
const prepared = (artifacts: string[] = []): Record<string, JsonValue> => ({
  version: 1, type: 'result', finishedAt: at, status: 'completed', result: 'done', metrics: { score: 1 }, decision: 'keep', artifacts,
  transition: { version: 1, revision: 2, at, sessionId: 'test', status: 'active', summary: 'done', lastRunId: 'run-1' },
})
const planRunId = '123e4567-e89b-42d3-b456-426614174001'
const planRef = { planId: 1, revision: 2, sha256: 'a'.repeat(64) }
const plannedPrepared = (artifacts: string[] = []): Record<string, JsonValue> => ({
  ...prepared(artifacts), version: 3, planRef,
  transition: { version: 2, revision: 2, at, sessionId: 'test', status: 'active', summary: 'done', lastRunId: planRunId, selectedPlanRef: planRef },
})
/** Deliberately test-only unconfined executor; production never imports child_process. */
const runner: GitRunner = command => new Promise((resolve, reject) => {
  const child = execFile(command.argv[0]!, [...command.argv.slice(1)], {
    cwd: command.cwd, env: command.env, encoding: 'buffer', maxBuffer: command.maxOutputBytes, signal: command.signal,
  }, (error, stdout, stderr) => {
    if (error && typeof error.code !== 'number') { reject(error); return }
    resolve({ stdout, stderr, exitCode: error?.code ?? 0 } as GitResult)
  })
  child.stdin?.on('error', () => {})
  child.stdin?.end(command.stdin)
})
let root: string
let ctx: Context
let provider: GitCheckpointProvider
const git = async (...argv: string[]): Promise<Buffer> => {
  const result = await runner({ argv: ['git', ...argv], cwd: root, env: gitEnvironment(), policy: { mode: 'workspace-write', workspaceRoot: root }, maxOutputBytes: 70 * 1024 * 1024 })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout
}
const put = async (file: string, content: string | Buffer): Promise<void> => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), content)
}
const start = (inputs: string[] = [], run = 'run-1') => provider.start(testSession(root), 'research-1', run, at, reproduction(inputs))
const pinned = async () => (await git('for-each-ref', '--format=%(refname)', 'refs/dsh')).toString().trim()

beforeEach(async () => {
  root = await makeWorkspace('checkpoint')
  ctx = testContext(root)
  Object.assign(ctx.fs, { processPath: (target: { path: string }) => target.path, processPathFromHostPath: (file: string) => file })
  provider = new GitCheckpointProvider(ctx, runner)
  await git('init', '--quiet')
  await put('code.txt', 'original\n')
  await git('add', 'code.txt')
  await git('commit', '-qm', 'initial')
})
afterEach(async () => { vi.unstubAllEnvs(); await removeWorkspace(root) })

describe('immutable raw Git checkpoints', () => {
  it('captures worktree bytes while preserving dirty staged/unstaged index and HEAD byte-for-byte', async () => {
    await put('code.txt', 'staged\n')
    await git('add', 'code.txt')
    await put('code.txt', 'unstaged\n')
    const index = await readFile(path.join(root, '.git/index'))
    const head = await readFile(path.join(root, '.git/HEAD'))
    const staged = await git('diff', '--cached', '--binary')
    const unstaged = await git('diff', '--binary')
    const input = await start()
    expect(await git('show', input.inputCommit + ':code.txt')).toEqual(Buffer.from('unstaged\n'))
    expect(await readFile(path.join(root, '.git/index'))).toEqual(index)
    expect(await readFile(path.join(root, '.git/HEAD'))).toEqual(head)
    expect(await git('diff', '--cached', '--binary')).toEqual(staged)
    expect(await git('diff', '--binary')).toEqual(unstaged)
    expect((await git('rev-parse', input.inputRef)).toString().trim()).toBe(input.inputCommit)
    await provider.finish(testSession(root), input, 'key', prepared())
    expect(await readFile(path.join(root, '.git/index'))).toEqual(index)
    expect(await readFile(path.join(root, '.git/HEAD'))).toEqual(head)
    expect(await readFile(path.join(root, 'code.txt'))).toEqual(Buffer.from('unstaged\n'))
    expect((await readdir(path.join(root, '.git'))).filter(name => name.startsWith('dsh-index-'))).toEqual([])
  })

  it('includes only explicit untracked inputs, excludes research metadata, captures raw binary without filters', async () => {
    const bytes = Buffer.from([0, 255, 254, 13, 10, 128, 0])
    await put('binary.bin', bytes)
    await put('ignored.txt', 'not included')
    await put('.research/state.jsonl', 'never include')
    await put('.gitattributes', '*.bin filter=explode text eol=lf\n')
    await git('add', '.research/state.jsonl', '.gitattributes')
    await git('config', 'filter.explode.clean', 'touch FILTER-RAN; exit 1')
    await git('config', 'filter.explode.required', 'true')
    const input = await start(['binary.bin'])
    expect(input.files).toEqual(['.gitattributes', 'binary.bin', 'code.txt'])
    expect(await git('show', input.inputCommit + ':binary.bin')).toEqual(bytes)
    expect(await lstat(path.join(root, 'FILTER-RAN')).catch(() => undefined)).toBeUndefined()
    const names = (await git('ls-tree', '-r', '--name-only', input.inputCommit)).toString()
    expect(names).not.toContain('.research')
    expect(names).not.toContain('ignored.txt')
  })

  it('freezes the start file set, hashes artifacts without adding them, and restores exact output bytes', async () => {
    await put('delete.txt', 'delete me')
    await git('add', 'delete.txt')
    const input = await start()
    await put('code.txt', 'output bytes\r\n')
    await chmod(path.join(root, 'code.txt'), 0o755)
    await rm(path.join(root, 'delete.txt'))
    await put('new-tracked.txt', 'not in frozen set')
    await git('add', 'new-tracked.txt')
    await put('report.bin', Buffer.from([0, 1, 255]))
    const index = await readFile(path.join(root, '.git/index'))
    const out = await provider.finish(testSession(root), input, 'same-request', prepared(['report.bin']))
    expect(out.checkpoint.codeChanged).toBe(true)
    expect(out.checkpoint.artifacts).toEqual([{ path: 'report.bin', bytes: 3, sha256: createHash('sha256').update(Buffer.from([0, 1, 255])).digest('hex') }])
    expect((await git('ls-tree', '-r', '--name-only', out.checkpoint.outputCommit)).toString()).toBe('code.txt\n')
    expect(await git('show', out.checkpoint.outputCommit + ':code.txt')).toEqual(Buffer.from('output bytes\r\n'))
    expect((await git('rev-parse', out.checkpoint.outputCommit + '^')).toString().trim()).toBe(input.inputCommit)
    expect((await git('ls-tree', out.checkpoint.outputCommit, 'code.txt')).toString()).toContain('100755')
    expect(await readFile(path.join(root, '.git/index'))).toEqual(index)
    // Restore into a separate directory with Git's test-only temporary index.
    const restore = path.join(root, 'restored')
    await mkdir(restore)
    const indexFile = path.join(root, 'restore-index')
    const restoreGit = async (args: string[]) => {
      const result = await runner({ argv: ['git', ...args], cwd: root, env: gitEnvironment({ GIT_INDEX_FILE: indexFile }), policy: { mode: 'workspace-write', workspaceRoot: root }, maxOutputBytes: 1024 * 1024 })
      expect(result.exitCode).toBe(0)
    }
    await restoreGit(['read-tree', out.checkpoint.outputTree])
    await restoreGit(['checkout-index', '--all', '--prefix=' + restore + '/'])
    expect(await readFile(path.join(restore, 'code.txt'))).toEqual(Buffer.from('output bytes\r\n'))
    expect(await readdir(restore)).toEqual(['code.txt'])
  })

  it('retries from output journal after workspace mutation and artifact deletion; rejects request conflict', async () => {
    const input = await start()
    await put('report', 'original artifact')
    const first = await provider.finish(testSession(root), input, 'key', prepared(['report']))
    await put('code.txt', 'changed after finish')
    await rm(path.join(root, 'report'))
    const retry = await provider.finish(testSession(root), input, 'key', { deliberately: 'not even valid new prepared metadata' })
    expect(retry).toEqual(first)
    expect(retry.checkpoint.codeChanged).toBe(false)
    const raw = (await git('cat-file', 'commit', first.checkpoint.outputCommit)).toString()
    const journal = JSON.parse(raw.slice(raw.indexOf('\n\n') + 2))
    expect(journal.prepared).toEqual(first.prepared)
    expect(journal.requestKey).toBe('key')
    expect(journal.checkpoint.outputCommit).toBeUndefined()
    await expect(provider.finish(testSession(root), input, 'different-key', prepared())).rejects.toThrow(/conflict/u)
  })

  it('rejects repeated start rather than recapturing an orphan input ref', async () => {
    await start()
    await put('code.txt', 'changed')
    await expect(start()).rejects.toThrow(/cannot be retried/u)
  })

  it('reproduces a deterministic fixture from restored input blobs and matches sealed artifact digest', async () => {
    await put('fixture.cjs', "const fs=require('node:fs'); const n=JSON.parse(fs.readFileSync('numbers.json','utf8')); fs.writeFileSync('answer.json', JSON.stringify(n.map(x=>x*2))+'\\n');")
    await put('numbers.json', '[2,3,5]')
    await git('add', 'fixture.cjs')
    const spec = { ...reproduction(['numbers.json']), command: 'node fixture.cjs' }
    const input = await provider.start(testSession(root), 'research-1', 'run-1', at, spec)
    const executeFixture = (cwd: string) => new Promise<void>((resolve, reject) => {
      execFile(process.execPath, ['fixture.cjs'], { cwd, env: { PATH: '/usr/bin:/bin' } }, error => error ? reject(error) : resolve())
    })
    await executeFixture(root)
    const output = await provider.finish(testSession(root), input, 'fixture-key', prepared(['answer.json']))
    await put('fixture.cjs', 'throw Error("mutated")')
    await put('numbers.json', '[0]')
    const restore = path.join(root, 'restored-fixture')
    await mkdir(restore)
    for (const file of input.files) {
      await mkdir(path.dirname(path.join(restore, file)), { recursive: true })
      await writeFile(path.join(restore, file), await git('show', input.inputCommit + ':' + file))
    }
    await executeFixture(restore)
    const reproduced = await readFile(path.join(restore, 'answer.json'))
    expect(createHash('sha256').update(reproduced).digest('hex')).toBe(output.checkpoint.artifacts[0]!.sha256)
  })

  it('uses SHA256 object identities when the repository does', async () => {
    await rm(path.join(root, '.git'), { recursive: true })
    await git('init', '--quiet', '--object-format=sha256')
    await git('add', 'code.txt')
    await git('commit', '-qm', 'sha256')
    const input = await start()
    expect(input.objectFormat).toBe('sha256')
    expect(input.inputCommit).toHaveLength(64)
    const output = await provider.finish(testSession(root), input, 'key', prepared())
    expect(output.checkpoint.outputCommit).toHaveLength(64)
  })
})

describe('versioned checkpoint journal compatibility', () => {
  const journalCheckpoint = (input: InputCheckpoint) => ({
    backend: 'git', inputCommit: input.inputCommit, inputTree: input.inputTree, outputTree: input.inputTree,
    inputRef: input.inputRef, outputRef: input.outputRef, objectFormat: input.objectFormat, artifacts: [], codeChanged: false,
  })
  const publishJournal = async (input: InputCheckpoint, version: number, original: Record<string, JsonValue>, requestKey: string) => {
    // Explicit fixture, independent of the current output-journal writer.
    const body = { version, type: 'dsh-research-output', requestKey, prepared: original, checkpoint: journalCheckpoint(input) }
    const commit = (await git('commit-tree', input.inputTree, '-p', input.inputCommit, '-m', JSON.stringify(body))).toString().trim()
    await git('update-ref', input.outputRef, commit)
    return commit
  }

  it('recovers an explicitly old envelope1/prepared1 journal without upgrading its transition', async () => {
    const input = await start()
    const original = prepared()
    const commit = await publishJournal(input, 1, original, 'legacy-request-key')
    await put('code.txt', 'changed after old output seal')
    const beforeCapture = vi.fn(async () => { throw new Error('must not inspect current plan') })
    const fresh = new GitCheckpointProvider(ctx, runner)
    const recovered = await fresh.finish(testSession(root), input, 'legacy-request-key', { ignored: 'new caller material' }, undefined, undefined, beforeCapture)
    expect(recovered.prepared).toEqual(original)
    expect(recovered.prepared.transition).toEqual({ version: 1, revision: 2, at, sessionId: 'test', status: 'active', summary: 'done', lastRunId: 'run-1' })
    expect(recovered.prepared).not.toHaveProperty('planRef')
    expect(recovered.prepared.transition).not.toHaveProperty('selectedPlanRef')
    expect(recovered.checkpoint.outputCommit).toBe(commit)
    expect(beforeCapture).not.toHaveBeenCalled()
  })

  it('writes envelope2/prepared3 without self-reference and replays the exact plan after mutation', async () => {
    const input = await start([], planRunId)
    const inputRaw = (await git('cat-file', 'commit', input.inputCommit)).toString()
    expect(JSON.parse(inputRaw.slice(inputRaw.indexOf('\n\n') + 2)).version).toBe(1)
    await put('report', 'original result')
    const original = plannedPrepared(['report'])
    const beforeCapture = vi.fn(async () => {})
    const first = await provider.finish(testSession(root), input, 'plan-request-key', original, undefined, undefined, beforeCapture)
    expect(beforeCapture).toHaveBeenCalledOnce()
    const raw = (await git('cat-file', 'commit', first.checkpoint.outputCommit)).toString()
    const journal = JSON.parse(raw.slice(raw.indexOf('\n\n') + 2))
    expect(journal.version).toBe(2)
    expect(journal.prepared).toEqual(original)
    expect(journal.prepared.version).toBe(3)
    expect(journal.prepared).not.toHaveProperty('checkpoint')
    expect(journal.checkpoint).not.toHaveProperty('outputCommit')
    await put('code.txt', 'changed after plan result was sealed')
    await rm(path.join(root, 'report'))
    const fresh = new GitCheckpointProvider(ctx, runner)
    const retry = await fresh.finish(testSession(root), input, 'plan-request-key', { ignored: 'not a new result' }, undefined, undefined, beforeCapture)
    expect(retry).toEqual(first)
    expect(retry.prepared.planRef).toEqual(planRef)
    expect(beforeCapture).toHaveBeenCalledOnce()
    await expect(fresh.finish(testSession(root), input, 'different-plan-key', original)).rejects.toThrow(/conflict/u)
  })

  it.each([[1, 3], [2, 1], [3, 3]])('rejects unsupported envelope/prepared pairing %i/%i', async (envelope, version) => {
    const input = await start([], planRunId)
    const original = version === 1 ? prepared() : plannedPrepared()
    await publishJournal(input, envelope!, original, 'key')
    const beforeCapture = vi.fn(async () => {})
    await expect(provider.finish(testSession(root), input, 'key', plannedPrepared(), undefined, undefined, beforeCapture)).rejects.toThrow(/journal/u)
    expect(beforeCapture).not.toHaveBeenCalled()
  })

  it('validates a recovered v3 plan/selection pairing rather than trusting journal version alone', async () => {
    const input = await start([], planRunId)
    const invalid = { ...plannedPrepared(), planRef: { ...planRef, revision: 3 } }
    await publishJournal(input, 2, invalid, 'key')
    await expect(provider.finish(testSession(root), input, 'key', plannedPrepared())).rejects.toThrow(/prepared plan result/u)
  })

  it('runs the optional integrity gate before first capture and publishes no output when it rejects', async () => {
    const input = await start([], planRunId)
    const spy = vi.fn(runner)
    const gated = new GitCheckpointProvider(ctx, spy)
    const beforeCapture = vi.fn(async () => { throw new Error('pinned plan digest changed') })
    await expect(gated.finish(testSession(root), input, 'key', plannedPrepared(), undefined, undefined, beforeCapture)).rejects.toMatchObject({ code: 'RESEARCH_CHECKPOINT_INVALID' })
    expect(beforeCapture).toHaveBeenCalledOnce()
    expect(spy.mock.calls.some(([command]) => command.argv.includes('hash-object') || command.argv.includes('commit-tree'))).toBe(false)
    expect(await pinned()).not.toContain('/output')
  })

  it.each(['missing-plan', 'different-selection', 'embedded-checkpoint'] as const)('rejects %s before publishing a v3 output', async problem => {
    const input = await start([], planRunId)
    const original = plannedPrepared()
    if (problem === 'missing-plan') delete original.planRef
    else if (problem === 'different-selection') original.planRef = { ...planRef, revision: 3 }
    else original.checkpoint = {}
    const beforeCapture = vi.fn(async () => {})
    await expect(provider.finish(testSession(root), input, 'key', original, undefined, undefined, beforeCapture)).rejects.toThrow(/prepared plan result/u)
    expect(beforeCapture).not.toHaveBeenCalled()
    expect(await pinned()).not.toContain('/output')
  })
})

describe('fail-closed checkpoint safety', () => {
  it('read-only fails before any Git command or filesystem write', async () => {
    ctx.sandboxPolicy.resolve = () => ({ mode: 'read-only', workspaceRoot: root })
    const spy = vi.fn(runner)
    provider = new GitCheckpointProvider(ctx, spy)
    const before = await readdir(path.join(root, '.git'))
    await expect(start()).rejects.toMatchObject({ code: 'RESEARCH_CHECKPOINT_INVALID' })
    expect(spy).not.toHaveBeenCalled()
    expect(await readdir(path.join(root, '.git'))).toEqual(before)
  })
  it('rejects nonGit and non-host-local workspaces', async () => {
    ctx.fs.processPathFromHostPath = () => undefined
    await expect(start()).rejects.toThrow(/host-local/u)
    ctx.fs.processPathFromHostPath = file => file
    await rm(path.join(root, '.git'), { recursive: true })
    await expect(start()).rejects.toMatchObject({ code: 'RESEARCH_CHECKPOINT_INVALID' })
  })
  it.each(['../escape', '/tmp/escape', 'dir/../code.txt', '.git/config', '.research/state', 'missing', '.env.local', 'key.pem', 'id_ed25519'])('rejects unsafe/missing explicit path %s', async file => {
    await expect(start([file])).rejects.toMatchObject({ code: 'RESEARCH_CHECKPOINT_INVALID' })
    expect(await pinned()).toBe('')
  })
  it('rejects tracked secrets and disguised private keys', async () => {
    await put('.env', 'PASSWORD=bad')
    await git('add', '.env')
    await expect(start()).rejects.toThrow(/secret/u)
    await git('rm', '--cached', '.env')
    await put('private.txt', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc')
    await expect(start(['private.txt'])).rejects.toThrow(/private key/u)
  })
  it('rejects symlink inputs, ancestor symlinks, directories, and nested repositories', async () => {
    await symlink('code.txt', path.join(root, 'link'))
    await expect(start(['link'])).rejects.toThrow(/symlink/u)
    await mkdir(path.join(root, 'dir'))
    await expect(start(['dir'])).rejects.toThrow(/regular/u)
    await symlink('dir', path.join(root, 'alias'))
    await expect(start(['alias/missing'])).rejects.toThrow(/symlink/u)
    await git('init', '--quiet', 'nested')
    await put('nested/data.txt', 'nested')
    await expect(start(['nested/data.txt'])).rejects.toThrow(/nested/u)
  })
  it('rejects linked worktrees and submodules', async () => {
    await git('worktree', 'add', '--detach', 'linked', 'HEAD')
    const linked = path.join(root, 'linked')
    await expect(provider.start(testSession(linked), 'r', 'run', at, reproduction())).rejects.toThrow(/linked worktrees/u)
    const head = (await git('rev-parse', 'HEAD')).toString().trim()
    await git('update-index', '--add', '--cacheinfo', '160000,' + head + ',submodule')
    await expect(start()).rejects.toThrow(/submodules/u)
  })
  it('rejects unresolved index merges', async () => {
    const blob = (await git('rev-parse', 'HEAD:code.txt')).toString().trim()
    const result = await runner({ argv: ['git', 'update-index', '--index-info'], cwd: root, env: gitEnvironment(), policy: { mode: 'workspace-write', workspaceRoot: root }, maxOutputBytes: 1024,
      stdin: Buffer.from('0 ' + '0'.repeat(40) + '\tcode.txt\n100644 ' + blob + ' 1\tcode.txt\n100644 ' + blob + ' 2\tcode.txt\n') })
    expect(result.exitCode).toBe(0)
    await expect(start()).rejects.toThrow(/merge/u)
  })
  it('rejects metadata symlinks and config includes before running Git', async () => {
    const config = path.join(root, '.git/config')
    await rename(config, path.join(root, 'external-config'))
    await symlink('../external-config', config)
    const spy = vi.fn(runner)
    provider = new GitCheckpointProvider(ctx, spy)
    await expect(start()).rejects.toThrow(/metadata/u)
    expect(spy).not.toHaveBeenCalled()
    await rm(config)
    await rename(path.join(root, 'external-config'), config)
    await git('config', 'include.path', '/tmp/not-allowed')
    spy.mockClear()
    await expect(start()).rejects.toThrow(/includes/u)
    expect(spy).not.toHaveBeenCalled()
  })
  it('hard-errors oversized tracked files instead of silently skipping', async () => {
    const handle = await open(path.join(root, 'code.txt'), 'w')
    await handle.truncate(CHECKPOINT_MAX_FILE_BYTES + 1)
    await handle.close()
    await expect(start()).rejects.toThrow(/size limit/u)
    expect(await pinned()).toBe('')
  })
  it('hard-errors excessive file count and aggregate snapshot bytes', async () => {
    await expect(start(Array.from({ length: 2001 }, (_, index) => 'file-' + index))).rejects.toThrow(/2000/u)
    const names = []
    for (let index = 0; index < 6; index++) {
      const file = 'large-' + index
      names.push(file)
      const handle = await open(path.join(root, file), 'w')
      await handle.truncate(CHECKPOINT_MAX_FILE_BYTES)
      await handle.close()
    }
    await expect(start(names)).rejects.toThrow(/50 MiB/u)
    expect(await pinned()).toBe('')
  })
  it('requires regular existing artifacts and enforces aggregate artifact cap', async () => {
    const input = await start()
    await mkdir(path.join(root, 'directory'))
    for (const artifact of ['missing', 'directory']) await expect(provider.finish(testSession(root), input, 'key', prepared([artifact]))).rejects.toThrow(/regular/u)
    const handle = await open(path.join(root, 'too-large'), 'w')
    await handle.truncate(1024 * 1024 * 1024 + 1)
    await handle.close()
    await expect(provider.finish(testSession(root), input, 'key', prepared(['too-large']))).rejects.toThrow(/1 GiB/u)
    expect(await pinned()).not.toContain('/output')
  })
  it('aborts publication when parent validation rejects the final payload', async () => {
    const input = await start()
    const validate = vi.fn(() => { throw new Error('parent record budget') })
    await expect(provider.finish(testSession(root), input, 'key', prepared(), undefined, validate)).rejects.toThrow()
    expect(validate).toHaveBeenCalledOnce()
    expect(await pinned()).not.toContain('/output')
  })
  it('does not inherit ambient Git redirects or run hooks/signing/fsmonitor', async () => {
    await put('.git/hooks/reference-transaction', '#!/bin/sh\ntouch HOOK-RAN\n')
    await chmod(path.join(root, '.git/hooks/reference-transaction'), 0o755)
    await git('config', 'commit.gpgSign', 'true')
    await git('config', 'core.fsmonitor', 'touch FSMONITOR-RAN')
    vi.stubEnv('GIT_INDEX_FILE', '/tmp/evil-index')
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.worktree')
    vi.stubEnv('GIT_CONFIG_VALUE_0', '/tmp')
    const input = await start()
    await provider.finish(testSession(root), input, 'key', prepared())
    expect(await lstat(path.join(root, 'HOOK-RAN')).catch(() => undefined)).toBeUndefined()
    expect(await lstat(path.join(root, 'FSMONITOR-RAN')).catch(() => undefined)).toBeUndefined()
  })
  it('detects artifact mutation after hashing and before publication', async () => {
    const input = await start()
    await put('report', 'before')
    const mutator: GitRunner = async command => {
      const result = await runner(command)
      if (command.argv.includes('commit-tree')) await put('report', 'after')
      return result
    }
    provider = new GitCheckpointProvider(ctx, mutator)
    await expect(provider.finish(testSession(root), input, 'key', prepared(['report']))).rejects.toThrow(/changed/u)
    expect(await pinned()).not.toContain('/output')
  })
  it('fails closed on a foreign output-ref CAS winner', async () => {
    const input = await start()
    const mutator: GitRunner = async command => {
      if (command.argv.includes('update-ref') && command.argv.includes(input.outputRef)) await git('update-ref', input.outputRef, input.baseHead)
      return await runner(command)
    }
    provider = new GitCheckpointProvider(ctx, mutator)
    await expect(provider.finish(testSession(root), input, 'key', prepared())).rejects.toThrow(/journal/u)
  })
})

describe('DSH Git runner seam', () => {
  it('confines exact argv and sends Buffer stdin over the alpha.3 raw pipe', async () => {
    const writes: Buffer[] = []
    const stdin = new PassThrough()
    stdin.on('data', chunk => writes.push(chunk))
    const confine = vi.fn((argv: string[]) => ({ argv: ['sandbox-wrapper', ...argv] }))
    const spawn = vi.fn(() => ({ stdin, stdout: Readable.from([Buffer.from([255, 0])]), stderr: Readable.from([]), done: Promise.resolve({ exitCode: 0 }), terminate: vi.fn() }))
    const runtime = createGitRunner({ subprocess: { resolveExecutable: async () => '/usr/bin/git', spawn }, sandbox: { confine } } as unknown as Context)
    const command: GitCommand = { argv: ['git', 'hash-object', '--stdin'], cwd: root, env: gitEnvironment(), policy: { mode: 'workspace-write', workspaceRoot: root }, stdin: Buffer.from([0, 255, 128]), maxOutputBytes: 1024 }
    const output = await runtime(command)
    expect(confine).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]![0].argv).toEqual(['sandbox-wrapper', '/usr/bin/git', 'hash-object', '--stdin'])
    expect(Buffer.concat(writes)).toEqual(command.stdin)
    expect(output.stdout).toEqual(Buffer.from([255, 0]))
  })
})
