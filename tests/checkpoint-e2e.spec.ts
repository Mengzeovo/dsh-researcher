import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitCheckpointProvider } from '../src/checkpoint.ts'
import { gitEnvironment, type GitRunner } from '../src/git-runtime.ts'
import { ResearchStore } from '../src/storage.ts'
import { failNextWrite, makeWorkspace, removeWorkspace, startPlannedTestRun, testContext, testSession } from './helpers.ts'
import { recoveryHost } from './recovery-helpers.ts'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await removeWorkspace(root) })
const runner: GitRunner = command => new Promise((resolve, reject) => {
  const child = execFile(command.argv[0]!, [...command.argv.slice(1)], { cwd: command.cwd, env: command.env, encoding: 'buffer', maxBuffer: command.maxOutputBytes, signal: command.signal }, (error, stdout, stderr) => {
    if (error && typeof error.code !== 'number') return reject(error)
    resolve({ exitCode: error?.code ?? 0, stdout, stderr })
  })
  child.stdin?.on('error', () => {})
  child.stdin?.end(command.stdin)
})

describe('actual Git + ResearchStore checkpoint transaction', () => {
  it('recovers after real output ref publication, then independently reproduces the captured result', async () => {
    const root = await makeWorkspace('checkpoint-e2e'); roots.push(root)
    const ctx = testContext(root)
    Object.assign(ctx.fs, { processPath: (target: { path: string }) => target.path, processPathFromHostPath: (file: string) => file })
    const git = async (...args: string[]) => {
      const result = await runner({ argv: ['git', ...args], cwd: root, env: gitEnvironment(), policy: { mode: 'workspace-write', workspaceRoot: root }, maxOutputBytes: 1024 * 1024 })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      return result.stdout
    }
    await git('init', '--quiet')
    await writeFile(path.join(root, 'experiment.cjs'), 'require("node:fs").writeFileSync("answer.json", JSON.stringify({score: 6 * 7}))')
    await git('add', 'experiment.cjs'); await git('commit', '-qm', 'initial fixture')
    const originalIndex = await readFile(path.join(root, '.git/index'))
    const originalHead = await git('rev-parse', 'HEAD')
    const store = new ResearchStore(ctx, new GitCheckpointProvider(ctx, runner))
    const session = testSession(root)
    const target = await store.createTarget(session, { goal: 'Reproduce score 42', metrics: ['score = 42'], baseline: 'score = 0' })
    const started = await startPlannedTestRun(store, session, target.id, { purpose: 'fixture', parameters: { seed: 7 }, reproduction: { command: 'node experiment.cjs', cwd: '.', inputs: [], environment: { node: process.versions.node } } })
    const baseState = (await store.readTarget(session, target.id)).state
    const selectedPlan = await store.getPlan(session, target.id, { planId: started.planRef.planId, revision: started.planRef.revision })
    expect(started.planRef).toEqual(baseState.selectedPlanRef)
    expect(started.planRef.sha256).toBe(selectedPlan.plan.sha256)
    const execute = (cwd: string) => new Promise<void>((resolve, reject) => execFile(process.execPath, ['experiment.cjs'], { cwd }, error => error ? reject(error) : resolve()))
    await execute(root)
    const request = { runId: started.runId, status: 'completed' as const, result: 'Score is 42', metrics: { score: 42 }, decision: 'keep', artifacts: ['answer.json'], researchStatus: 'active' as const, summary: 'Fixture complete' }
    await failNextWrite(ctx, started.path, 'interrupt after Git seal', 'replaceIfVersion')
    await expect(store.finishRun(session, target.id, request)).rejects.toThrow('interrupt after Git seal')
    const sealed = (await git('rev-parse', started.checkpoint.outputRef)).toString().trim()
    expect((await store.readRun(session, target.id, started.runId)).result).toBeUndefined()
    expect((await store.readTarget(session, target.id)).state.revision).toBe(baseState.revision)
    await writeFile(path.join(root, 'experiment.cjs'), 'throw Error("later mutation")')
    await rm(path.join(root, 'answer.json'))
    await rm(path.join(root, selectedPlan.path))
    const restarted = new ResearchStore(ctx, new GitCheckpointProvider(ctx, runner))
    const fresh = recoveryHost(ctx, restarted, root)
    const loaded = await fresh.service.load(fresh.agent, target.id)
    expect(loaded.mode).toBe('recovery-only')
    expect(loaded.target.recovery).toMatchObject({ runId: started.runId, phase: 'open', outputRef: started.checkpoint.outputRef, planRef: started.planRef })
    expect(loaded.target.state.selectedPlanRef).toEqual(started.planRef)
    expect(loaded.target.warnings.some(warning => warning.startsWith('Selected plan integrity error:'))).toBe(true)
    expect(fresh.goals.create).not.toHaveBeenCalled()
    // Discover the exact retry payload from the durable Git journal, not old session memory.
    const journal = JSON.parse((await git('show', '--no-patch', '--format=%B', loaded.target.recovery!.outputRef!)).toString())
    expect(journal.version).toBe(2)
    expect(journal.checkpoint).not.toHaveProperty('outputCommit')
    const prepared = journal.prepared
    expect(prepared).toMatchObject({ version: 3, planRef: started.planRef, transition: { version: 2, selectedPlanRef: started.planRef, revision: baseState.revision + 1 } })
    expect(prepared).not.toHaveProperty('checkpoint')
    const retry = { runId: loaded.target.recovery!.runId, status: prepared.status, result: prepared.result, metrics: prepared.metrics, decision: prepared.decision, artifacts: prepared.artifacts, researchStatus: prepared.transition.status, summary: prepared.transition.summary }
    const finished = await fresh.service.finishRun(fresh.agent, retry)
    expect(finished.state).toEqual(prepared.transition)
    expect(finished.planRef).toEqual(started.planRef)
    expect((await fresh.service.get(fresh.agent)).target.recovery).toBeUndefined()
    expect(fresh.goals.create).not.toHaveBeenCalled()
    expect(finished.checkpoint?.outputCommit).toBe(sealed)
    expect(finished.checkpoint?.codeChanged).toBe(false)
    expect(finished.state.revision).toBe(baseState.revision + 1)
    expect(await readFile(path.join(root, '.git/index'))).toEqual(originalIndex)
    expect(await git('rev-parse', 'HEAD')).toEqual(originalHead)
    const restored = path.join(root, 'replay'); await mkdir(restored)
    await writeFile(path.join(restored, 'experiment.cjs'), await git('cat-file', 'blob', started.checkpoint.inputCommit + ':experiment.cjs'))
    await execute(restored)
    const replay = await readFile(path.join(restored, 'answer.json'))
    expect(JSON.parse(replay.toString())).toEqual(request.metrics)
    expect(createHash('sha256').update(replay).digest('hex')).toBe(finished.checkpoint!.artifacts[0]!.sha256)
    expect((await restarted.finishRun(session, target.id, request)).state).toEqual(finished.state)
    expect((await readFile(path.join(root, target.root, 'state.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(baseState.revision + 1)
  }, 30_000)
})
