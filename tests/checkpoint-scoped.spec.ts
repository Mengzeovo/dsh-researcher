import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitCheckpointProvider, CHECKPOINT_MAX_FILE_BYTES, type ArtifactDigest, type ReproductionSpec } from '../src/checkpoint.ts'
import { gitEnvironment, type GitRunner, type GitResult } from '../src/git-runtime.ts'
import { failNextWrite, makeWorkspace, removeWorkspace, startPlannedTestRun, testContext, testSession } from './helpers.ts'
import { ResearchStore } from '../src/storage.ts'

const RUN = '123e4567-e89b-42d3-b456-426614174001'
const RESEARCH = '123e4567-e89b-42d3-b456-426614174002'
const at = '2026-09-14T00:00:00.000Z'
const planRef = { planId: 3, revision: 5, sha256: 'a'.repeat(64) }
const prepared = (artifacts: string[] = []): Record<string, JsonValue> => ({
  version: 3, type: 'result', finishedAt: at, status: 'completed', result: 'fixture only', metrics: {}, decision: 'verified', artifacts, planRef,
  transition: { version: 2, revision: 2, at, sessionId: 'test', status: 'active', summary: 'fixture', lastRunId: RUN, selectedPlanRef: planRef },
})
/** Test-only executor; production processes continue to use the DSH runtime. */
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
const gitInput = async (argv: string[], stdin?: Buffer): Promise<Buffer> => {
  const result = await runner({ argv: ['git', ...argv], cwd: root, env: gitEnvironment(), policy: { mode: 'workspace-write', workspaceRoot: root }, maxOutputBytes: 2 * 1024 * 1024, ...(stdin ? { stdin } : {}) })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout
}
const git = (...argv: string[]) => gitInput(argv)
const put = async (file: string, bytes: string | Buffer): Promise<void> => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), bytes)
}
const scoped = (paths = ['code.txt'], inputs: string[] = [], externalInputs: ArtifactDigest[] = []): ReproductionSpec => ({
  command: 'fixture-command-never-automatically-executed', cwd: '.', inputs, environment: {}, snapshot: { mode: 'scoped', paths, externalInputs },
})
const start = (repro = scoped()) => provider.start(testSession(root), RESEARCH, RUN, at, repro)
const refs = async () => (await git('for-each-ref', '--format=%(refname)', 'refs/dsh')).toString()
const digest = async (file: string): Promise<ArtifactDigest> => {
  const bytes = await readFile(path.join(root, file))
  return { path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

beforeEach(async () => {
  root = await makeWorkspace('scoped-checkpoint')
  ctx = testContext(root)
  Object.assign(ctx.fs, { processPath: (target: { path: string }) => target.path, processPathFromHostPath: (file: string) => file })
  provider = new GitCheckpointProvider(ctx, runner)
  await git('init', '--quiet')
  await put('code.txt', 'base bytes\n')
  await git('add', 'code.txt')
  await git('commit', '-qm', 'base')
})
afterEach(async () => { await removeWorkspace(root) })

describe('explicit scoped overlays', () => {
  it('retains frozen deletion semantics when an index-only addition is removed from both index and worktree', async () => {
    await put('src/new.ts', 'staged only')
    await git('add', 'src/new.ts')
    const input = await start(scoped(['src']))
    await git('rm', '-f', 'src/new.ts')
    const output = await provider.finish(testSession(root), input, 'k', prepared())
    expect(output.checkpoint.snapshot?.deleted).toEqual(['src/new.ts'])
    expect(output.checkpoint.codeChanged).toBe(true)
  })

  it.each(['gitlink', 'external-symlink'])('rejects a forged same-name %s tree rather than trusting its journal', async kind => {
    const input = await start()
    const output = await provider.finish(testSession(root), input, 'k', prepared())
    const raw = (await git('cat-file', 'commit', output.checkpoint.outputCommit)).toString()
    const body = JSON.parse(raw.slice(raw.indexOf('\n\n') + 2))
    const linkOid = (await gitInput(['hash-object', '-w', '--stdin'], Buffer.from('/etc/passwd'))).toString().trim()
    const record = kind === 'gitlink' ? '160000 commit ' + input.baseHead : '120000 blob ' + linkOid
    const tree = (await gitInput(['mktree'], Buffer.from(record + '\tcode.txt\n'))).toString().trim()
    body.checkpoint.outputTree = tree
    body.checkpoint.codeChanged = tree !== input.inputTree
    const forged = (await gitInput(['commit-tree', tree, '-p', input.inputCommit], Buffer.from(JSON.stringify(body) + '\n'))).toString().trim()
    await git('update-ref', input.outputRef, forged, output.checkpoint.outputCommit)
    await expect(provider.finish(testSession(root), input, 'k', prepared())).rejects.toThrow(/unsupported overlay entry|unsafe tracked symlink target/u)
  })


  it('round-trips real scoped run records and recovers after seal even when external data disappear', async () => {
    const store = new ResearchStore(ctx, provider)
    const session = testSession(root)
    const target = await store.createTarget(session, { goal: 'scoped fixture', metrics: ['exact records'], baseline: 'base Git' })
    await put('power.bin', 'retained data')
    const started = await startPlannedTestRun(store, session, target.id, { purpose: 'integration fixture', parameters: {}, reproduction: scoped(['code.txt'], [], [await digest('power.bin')]) })
    const open = await store.readRun(session, target.id, started.runId)
    expect(open.description).toMatchObject({ version: 3, checkpoint: { snapshot: { mode: 'scoped-overlay', deleted: [], omittedChanges: [] } } })
    await put('answer.json', '{"fixture":true}')
    const request = { runId: started.runId, status: 'completed' as const, result: 'fixture success', metrics: {}, decision: 'keep', artifacts: ['answer.json'], researchStatus: 'active' as const, summary: 'fixture result' }
    await failNextWrite(ctx, started.path, 'injected scoped result publication failure', 'replaceIfVersion')
    await expect(store.finishRun(session, target.id, request)).rejects.toThrow(/injected/u)
    expect(await refs()).toContain('/output')
    await rm(path.join(root, 'power.bin'))
    await rm(path.join(root, 'answer.json'))
    const fresh = new ResearchStore(ctx, new GitCheckpointProvider(ctx, runner))
    const finished = await fresh.finishRun(session, target.id, request)
    expect(finished.checkpoint?.snapshot?.baseHead).toBe(started.checkpoint.baseHead)
    expect((await fresh.readRun(session, target.id, started.runId)).result).toMatchObject({ version: 3, checkpoint: { snapshot: { mode: 'scoped-overlay' } } })
  })

  it('preflights actual complete ResearchStore descriptions before any input ref is published', async () => {
    for (let i = 0; i < 150; i++) await put('src/' + String(i).padStart(3, '0') + '-'.repeat(100) + '.ts', 'x')
    await git('add', 'src'); await git('commit', '-qm', 'long selected filenames')
    const store = new ResearchStore(ctx, provider)
    const session = testSession(root)
    const target = await store.createTarget(session, { goal: 'metadata limit fixture', metrics: ['no orphan ref'], baseline: 'base Git' })
    await expect(startPlannedTestRun(store, session, target.id, { purpose: 'metadata limit', parameters: { padding: 'x'.repeat(60000) }, reproduction: scoped(['src']) })).rejects.toThrow(/exceeds|65536|64 KiB/u)
    expect(await refs()).toBe('')
  })

  it('rejects a forged deletion manifest inconsistent with the sealed overlay tree', async () => {
    const input = await start()
    const output = await provider.finish(testSession(root), input, 'k', prepared())
    provider = new GitCheckpointProvider(ctx, async command => {
      const result = await runner(command)
      if (command.argv.includes('cat-file') && command.argv.at(-1) === output.checkpoint.outputCommit) {
        const raw = result.stdout.toString()
        const separator = raw.indexOf('\n\n')
        const body = JSON.parse(raw.slice(separator + 2))
        body.checkpoint.snapshot.deleted = ['code.txt']
        return { ...result, stdout: Buffer.from(raw.slice(0, separator + 2) + JSON.stringify(body) + '\n') }
      }
      return result
    })
    await expect(provider.finish(testSession(root), input, 'k', prepared())).rejects.toThrow(/overlay tree and deletion manifest disagree/u)
  })

  it('preserves selected relative symlink bytes and mode without capturing its target', async () => {
    await mkdir(path.join(root, 'src'))
    await symlink('../code.txt', path.join(root, 'src/link'))
    await git('add', 'src/link')
    const input = await start(scoped(['src']))
    expect(input.files).toEqual(['src/link'])
    expect((await git('show', input.inputCommit + ':src/link')).toString()).toBe('../code.txt')
    expect((await git('ls-tree', '-r', input.inputCommit)).toString()).toContain('120000 blob')
    const output = await provider.finish(testSession(root), input, 'k', prepared())
    expect(output.checkpoint.codeChanged).toBe(false)
  })


  it('requires review of all outside-scope tracked edits rather than silently skipping them', async () => {
    await put('outside.txt', 'base')
    await git('add', 'outside.txt'); await git('commit', '-qm', 'outside base')
    await put('outside.txt', 'changed outside')
    await expect(start()).rejects.toThrow(/snapshot.omitChanges acknowledgement/u)
    expect(await refs()).toBe('')
    const recipe = scoped()
    recipe.snapshot!.omitChanges = ['outside.txt']
    const input = await start(recipe)
    expect(input.snapshot?.omittedChanges).toEqual(['outside.txt'])
    await put('outside.txt', 'another outside change')
    const output = await provider.finish(testSession(root), input, 'k', prepared())
    expect(output.checkpoint.codeChanged).toBe(false) // explicitly scope-limited, not a whole-tree assertion
  })

  it('leaves the default all-tracked contract and journal byte shape unchanged', async () => {
    const input = await start({ command: 'x', cwd: '.', environment: {}, inputs: [] })
    expect(input).not.toHaveProperty('snapshot')
    expect(input.reproduction).not.toHaveProperty('snapshot')
    const raw = (await git('cat-file', 'commit', input.inputCommit)).toString()
    expect(JSON.parse(raw.slice(raw.indexOf('\n\n') + 2)).version).toBe(1)
    const output = await provider.finish(testSession(root), input, 'k', prepared())
    expect(output.checkpoint).not.toHaveProperty('snapshot')
  })

  it('captures selected working bytes, keeps an immutable base, and reports omitted tracked changes', async () => {
    await put('src/one.ts', 'base source')
    await put('src-extra/two.ts', 'unrelated')
    await git('add', 'src', 'src-extra')
    await git('commit', '-qm', 'more base')
    await put('src/one.ts', 'dirty source')
    await put('src-extra/two.ts', 'dirty outside')
    const index = await readFile(path.join(root, '.git/index'))
    const head = (await git('rev-parse', 'HEAD')).toString().trim()
    const recipe = scoped(['src'])
    recipe.snapshot!.omitChanges = ['src-extra/two.ts']
    const input = await start(recipe)
    expect(input.files).toEqual(['src/one.ts'])
    expect(input.snapshot).toEqual({ mode: 'scoped-overlay', deleted: [], omittedChanges: ['src-extra/two.ts'] })
    expect(input.baseHead).toBe(head)
    expect((await git('rev-parse', input.inputCommit + '^')).toString().trim()).toBe(head)
    expect((await git('show', input.inputCommit + ':src/one.ts')).toString()).toBe('dirty source')
    expect(await readFile(path.join(root, '.git/index'))).toEqual(index)
    expect((await git('rev-parse', 'HEAD')).toString().trim()).toBe(head)
    const raw = (await git('cat-file', 'commit', input.inputCommit)).toString()
    expect(JSON.parse(raw.slice(raw.indexOf('\n\n') + 2)).version).toBe(2)
  })

  it('does not read oversized or >2000 unrelated tracked files, but retains all hard capture limits', async () => {
    await mkdir(path.join(root, 'docs'))
    for (let i = 0; i < 2001; i++) await put(`docs/f${i}.txt`, 'unused')
    await put('docs/large.bin', Buffer.alloc(CHECKPOINT_MAX_FILE_BYTES + 1))
    await git('add', 'docs')
    await git('commit', '-qm', 'large unrelated base')
    const input = await start()
    expect(input.files).toEqual(['code.txt'])
    expect((await git('ls-tree', '-r', '--name-only', input.inputCommit)).toString()).toBe('code.txt\n')
    await expect(provider.start(testSession(root), RESEARCH, 'run-all', at, { command: 'x', cwd: '.', environment: {}, inputs: [] })).rejects.toThrow(/2000 file limit/u)
    await expect(provider.start(testSession(root), RESEARCH, 'run-big', at, scoped(['docs/large.bin']))).rejects.toThrow(/size limit/u)
    expect(await refs()).not.toContain('run-all')
    expect(await refs()).not.toContain('run-big')
  })

  it('refuses undeclared untracked scoped files, then captures explicitly declared input bytes', async () => {
    await put('src/new.ts', 'untracked input')
    await expect(start(scoped(['src']))).rejects.toThrow(/scope matches no|untracked scoped/u)
    expect(await refs()).toBe('')
    const input = await start(scoped(['src'], ['src/new.ts']))
    expect(input.files).toEqual(['src/new.ts'])
    expect((await git('show', input.inputCommit + ':src/new.ts')).toString()).toBe('untracked input')
  })

  it.each(['unknown', 'src/', '../outside', '.', '.git', '.research', 'code.txt/*'])('rejects empty or unsafe/mistyped scope %s', async scope => {
    await expect(start(scoped([scope]))).rejects.toThrow()
    expect(await refs()).toBe('')
  })

  it('records absent baseline paths as deletions and detects later deletions within the frozen set', async () => {
    await put('src/deleted.ts', 'base')
    await put('src/remaining.ts', 'base')
    await git('add', 'src')
    await git('commit', '-qm', 'files to delete')
    await rm(path.join(root, 'src/deleted.ts'))
    const input = await start(scoped(['src']))
    expect(input.snapshot?.deleted).toEqual(['src/deleted.ts'])
    await rm(path.join(root, 'src/remaining.ts'))
    const out = await provider.finish(testSession(root), input, 'k', prepared())
    expect(out.checkpoint.snapshot).toEqual({ mode: 'scoped-overlay', baseHead: input.baseHead, deleted: ['src/deleted.ts', 'src/remaining.ts'] })
    expect(out.checkpoint.codeChanged).toBe(true)
    expect((await git('ls-tree', '-r', '--name-only', out.checkpoint.outputCommit)).toString()).toBe('')
  })

  it.each([false, true])('rejects newly introduced scoped source at finish, tracked=%s', async tracked => {
    await put('src/main.ts', 'base')
    await git('add', 'src')
    const input = await start(scoped(['src']))
    await put('src/new.ts', 'undeclared during execution')
    if (tracked) await git('add', 'src/new.ts')
    await expect(provider.finish(testSession(root), input, 'k', prepared())).rejects.toThrow(/untracked scoped|new scoped source/u)
    expect(await refs()).not.toContain('/output')
  })

  it('streams declared data hashes outside the code tree and checks before first finish only', async () => {
    await put('data/power.bin', Buffer.alloc(CHECKPOINT_MAX_FILE_BYTES + 1, 13))
    const data = await digest('data/power.bin')
    const input = await start(scoped(['code.txt'], [], [data]))
    expect(input.files).toEqual(['code.txt'])
    expect(input.reproduction.snapshot?.externalInputs).toEqual([data])
    const output = await provider.finish(testSession(root), input, 'k', prepared())
    await rm(path.join(root, 'data/power.bin'))
    const replay = await provider.finish(testSession(root), input, 'k', { notAResult: true })
    expect(replay).toEqual(output)
    const raw = (await git('cat-file', 'commit', output.checkpoint.outputCommit)).toString()
    expect(JSON.parse(raw.slice(raw.indexOf('\n\n') + 2)).version).toBe(3)
  })

  it('does not capture a declared external input even when tracked under the chosen prefix', async () => {
    await put('src/power.bin', 'data')
    await git('add', 'src')
    const input = await start(scoped(['src'], [], [await digest('src/power.bin')]))
    expect(input.files).toEqual([])
    expect(input.snapshot?.deleted).toEqual([])
    expect(input.reproduction.snapshot?.externalInputs?.[0]?.path).toBe('src/power.bin')
  })

  it.each(['bytes', 'sha256'] as const)('rejects wrong external %s before publication', async field => {
    await put('data.bin', 'content')
    const data = await digest('data.bin')
    const bad = field === 'bytes' ? { ...data, bytes: data.bytes + 1 } : { ...data, sha256: '0'.repeat(64) }
    await expect(start(scoped(['code.txt'], [], [bad]))).rejects.toThrow(/external input size or SHA-256 mismatch/u)
    expect(await refs()).toBe('')
  })

  it('rejects changed external data on first finish instead of sealing misleading provenance', async () => {
    await put('data.bin', 'original')
    const input = await start(scoped(['code.txt'], [], [await digest('data.bin')]))
    await put('data.bin', 'modified')
    await expect(provider.finish(testSession(root), input, 'k', prepared())).rejects.toThrow(/external input size or SHA-256 mismatch/u)
    expect(await refs()).not.toContain('/output')
  })

  it('keeps external data and scope ancestors no-follow', async () => {
    await put('data.bin', 'content')
    const data = await digest('data.bin')
    await symlink('data.bin', path.join(root, 'linked'))
    await expect(start(scoped(['code.txt'], [], [{ ...data, path: 'linked' }]))).rejects.toThrow(/symlink/u)
    await mkdir(path.join(root, 'actual'))
    await symlink('actual', path.join(root, 'parent'))
    await git('add', 'parent')
    await put('actual/x.txt', 'content')
    await expect(start(scoped(['parent'], ['parent/x.txt']))).rejects.toThrow(/symlink/u)
  })

  it('preflights complete run metadata before publishing an input reference', async () => {
    await expect(provider.start(testSession(root), RESEARCH, RUN, at, scoped(), undefined, () => {
      throw new Error('complete run description exceeds 64 KiB')
    })).rejects.toThrow(/no run was executed/u)
    expect(await refs()).toBe('')
  })

  it('detects referenced data mutation after hashing and before input publication', async () => {
    await put('data.bin', 'content')
    const repro = scoped(['code.txt'], [], [await digest('data.bin')])
    let mutated = false
    provider = new GitCheckpointProvider(ctx, async command => {
      const result = await runner(command)
      if (!mutated && command.argv.includes('commit-tree')) { mutated = true; await put('data.bin', 'changed') }
      return result
    })
    await expect(start(repro)).rejects.toThrow(/changed before checkpoint publication/u)
    expect(await refs()).toBe('')
  })

  it('independently reconstructs base + raw overlay + deletion and reproduces output', async () => {
    await put('fixture.cjs', "const fs=require('node:fs');const factor=require('./factor.cjs');if(fs.existsSync('obsolete.txt'))throw Error('deletion lost');fs.writeFileSync('answer.json',JSON.stringify(JSON.parse(fs.readFileSync('data.json','utf8')).map(n=>n*factor)));\n")
    await put('factor.cjs', 'module.exports=1;\n')
    await put('obsolete.txt', 'must be deleted')
    await put('outside.txt', 'baseline outside scope')
    await git('add', 'fixture.cjs', 'factor.cjs', 'obsolete.txt', 'outside.txt')
    await git('commit', '-qm', 'fixture base')
    await put('factor.cjs', 'module.exports=3;\n')
    await chmod(path.join(root, 'fixture.cjs'), 0o755)
    await rm(path.join(root, 'obsolete.txt'))
    await put('outside.txt', 'unrelated dirty outside')
    await put('data.json', '[2,3,5]')
    const recipe = scoped(['fixture.cjs', 'factor.cjs', 'obsolete.txt'], [], [await digest('data.json')])
    recipe.snapshot!.omitChanges = ['outside.txt']
    const input = await start(recipe)
    const execute = (cwd: string) => new Promise<void>((resolve, reject) => {
      execFile(process.execPath, ['fixture.cjs'], { cwd }, error => error ? reject(error) : resolve())
    })
    await execute(root)
    const output = await provider.finish(testSession(root), input, 'k', prepared(['answer.json']))
    const restored = path.join(root, 'restored')
    await mkdir(restored)
    const overlay = async (commit: string) => {
      const rows = (await git('ls-tree', '-r', '-z', commit)).toString().split('\0').filter(Boolean)
      for (const row of rows) {
        const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/u.exec(row)!
        const file = path.join(restored, match[3]!)
        await mkdir(path.dirname(file), { recursive: true })
        await rm(file, { force: true })
        const bytes = await git('cat-file', 'blob', match[2]!)
        if (match[1] === '120000') await symlink(bytes.toString(), file)
        else { await writeFile(file, bytes); await chmod(file, match[1] === '100755' ? 0o755 : 0o644) }
      }
    }
    await overlay(input.baseHead)
    await overlay(input.inputCommit)
    for (const file of input.snapshot!.deleted) await rm(path.join(restored, file), { force: true })
    await copyFile(path.join(root, 'data.json'), path.join(restored, 'data.json'))
    await execute(restored)
    expect(await readFile(path.join(restored, 'outside.txt'), 'utf8')).toBe('baseline outside scope')
    expect(await lstat(path.join(restored, 'obsolete.txt')).catch(() => undefined)).toBeUndefined()
    expect((await lstat(path.join(restored, 'fixture.cjs'))).mode & 0o111).not.toBe(0)
    const bytes = await readFile(path.join(restored, 'answer.json'))
    expect(bytes.toString()).toBe('[6,9,15]')
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(output.checkpoint.artifacts[0]?.sha256)
  })
})
