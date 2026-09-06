import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createGitRunner, gitEnvironment } from '../src/git-runtime.ts'

/** Controlled local test adapter; production uses the real managed DSH capability. */
function runtime() {
  const confine = vi.fn((argv: readonly string[]) => ({ argv: [...argv] }))
  const spawnChild = vi.fn((spec: { argv: string[]; cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal }) => {
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, signal: spec.signal, stdio: ['pipe', 'pipe', 'pipe'] })
    const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
    })
    return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, done, terminate: () => { child.kill('SIGKILL') } }
  })
  const ctx = { sandbox: { confine }, subprocess: { resolveExecutable: vi.fn(async () => process.execPath), spawn: spawnChild } } as unknown as Context
  return { run: createGitRunner(ctx), confine, spawnChild }
}
const base = { cwd: process.cwd(), policy: { mode: 'workspace-write' as const, workspaceRoot: process.cwd() }, env: gitEnvironment(), maxOutputBytes: 4096 }

describe('managed checkpoint Git runtime', () => {
  it('uses confinement and preserves binary stdin/stdout without shell interpretation', async () => {
    const { run, confine, spawnChild } = runtime()
    const bytes = Buffer.from([0, 255, 128, 10, 39, 36])
    const result = await run({ ...base, argv: ['git', '-e', 'process.stdin.pipe(process.stdout)'], stdin: bytes })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.equals(bytes)).toBe(true)
    expect(confine).toHaveBeenCalledOnce()
    expect(spawnChild.mock.calls[0]![0].argv[0]).toBe(process.execPath)
    expect(spawnChild.mock.calls[0]![0].env.GIT_CONFIG_NOSYSTEM).toBe('1')
  })
  it('retains nonzero Git exit status and enforces capture bounds', async () => {
    const { run } = runtime()
    const failed = await run({ ...base, argv: ['git', '-e', 'process.stderr.write("expected"); process.exitCode=7'] })
    expect(failed.exitCode).toBe(7)
    expect(failed.stderr.toString()).toBe('expected')
    await expect(run({ ...base, maxOutputBytes: 10, argv: ['git', '-e', 'process.stdout.write("x".repeat(1000))'] })).rejects.toMatchObject({ code: 'RESEARCH_CHECKPOINT_INVALID' })
  })
  it('does not confine unrestricted calls and honors an already-aborted signal', async () => {
    const { run, confine, spawnChild } = runtime()
    await run({ ...base, policy: { ...base.policy, mode: 'danger-full-access' }, argv: ['git', '-e', ''] })
    expect(confine).not.toHaveBeenCalled()
    await expect(run({ ...base, signal: AbortSignal.abort(), argv: ['git', '-e', ''] })).rejects.toBeDefined()
    expect(spawnChild).toHaveBeenCalledTimes(1)
  })
  it('fails before spawn when the configured sandbox cannot enforce policy', async () => {
    const spawnChild = vi.fn()
    const ctx = { subprocess: { resolveExecutable: async () => '/usr/bin/git', spawn: spawnChild }, sandbox: { confine: () => { throw new Error('sandbox unavailable') } } } as unknown as Context
    await expect(createGitRunner(ctx)({ ...base, argv: ['git', 'version'] })).rejects.toThrow('sandbox unavailable')
    expect(spawnChild).not.toHaveBeenCalled()
  })
  it('tombstones ambient Git overrides and credentials', () => {
    const old = process.env.GIT_DIR
    const secret = process.env.TEST_CHECKPOINT_SECRET
    try {
      process.env.GIT_DIR = '/outside'
      process.env.TEST_CHECKPOINT_SECRET = 'must-not-inherit'
      const env = gitEnvironment()
      expect(Object.hasOwn(env, 'GIT_DIR')).toBe(true)
      expect(env.GIT_DIR).toBeUndefined()
      expect(env.TEST_CHECKPOINT_SECRET).toBeUndefined()
      expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    } finally {
      if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old
      if (secret === undefined) delete process.env.TEST_CHECKPOINT_SECRET; else process.env.TEST_CHECKPOINT_SECRET = secret
    }
  })
})
