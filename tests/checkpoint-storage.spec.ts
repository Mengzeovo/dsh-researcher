import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRunId } from '../src/schema.ts'
import { ResearchStore } from '../src/storage.ts'
import type { FinishResearchRunRequest, RunId, StartResearchRunRequest } from '../src/types.ts'
import { failNextWrite, makeWorkspace, mockCheckpoints, removeWorkspace, testContext, testReproduction, testSession } from './helpers.ts'

let workspace: string

beforeEach(async () => {
  workspace = await makeWorkspace('dsh-researcher-checkpoint-store')
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await removeWorkspace(workspace)
})

async function fixture() {
  const ctx = testContext(workspace)
  const checkpoints = mockCheckpoints()
  const store = new ResearchStore(ctx, checkpoints)
  const session = testSession(workspace)
  const target = await store.createTarget(session, {
    goal: 'Preserve exact reproducible run records across interrupted publication.',
    metrics: ['one immutable output checkpoint and one state transition'],
    baseline: 'active state revision 1',
  })
  return { ctx, checkpoints, store, session, target }
}

function startRequest(): StartResearchRunRequest {
  return { purpose: 'controlled execution', parameters: { seed: 7 }, reproduction: testReproduction() }
}

function finishRequest(runId: RunId): FinishResearchRunRequest {
  return {
    runId,
    status: 'completed',
    result: 'The candidate is below baseline: a completed negative scientific result.',
    metrics: { score: 0.9, baseline: 1, improved: false },
    decision: 'reject this candidate and change the method',
    artifacts: [],
    researchStatus: 'active',
    summary: 'A valid negative result was recorded.',
    direction: 'try a different candidate',
    next: 'prepare seed 8',
  }
}

describe('ResearchStore checkpoint integration', () => {
  it('freezes the base revision and reproduction, delegates exact arguments, and publishes v2 metadata', async () => {
    const { store, session, target, checkpoints } = await fixture()
    await store.appendState(session, target.id, { status: 'active', summary: 'baseline is ready' })
    await mkdir(path.join(workspace, 'data'))
    await writeFile(path.join(workspace, 'data/input.json'), '{"seed":7}\n')
    const reproduction = testReproduction({
      command: 'node experiment.mjs --input ../data/input.json',
      cwd: 'scripts',
      environment: { runtime: 'Node.js 22', hardware: { cpu: 'test fixture', gpu: null }, deterministic: true },
      inputs: ['data/input.json'],
    })
    const signal = new AbortController().signal
    const started = await store.startRun(session, target.id, { ...startRequest(), reproduction }, signal)
    const open = await store.readRun(session, target.id, started.runId)
    expect(open.description).toMatchObject({ version: 2, baseStateRevision: 2, checkpoint: { reproduction } })
    expect(open.result).toBeUndefined()
    expect(checkpoints.start).toHaveBeenCalledExactlyOnceWith(
      session, target.id, started.runId, open.description.createdAt, reproduction, signal,
    )
    const input = await checkpoints.start.mock.results[0]!.value
    expect(started.checkpoint).toEqual(input)
    expect(open.description).toHaveProperty('checkpoint', input)
    expect((await store.readTarget(session, target.id)).state.revision).toBe(2)

    const bytes = Buffer.from('{"score":0.9}\n')
    await writeFile(path.join(workspace, 'result.json'), bytes)
    const request = { ...finishRequest(started.runId), artifacts: ['result.json'] }
    const finished = await store.finishRun(session, target.id, request, signal)
    expect(checkpoints.finish).toHaveBeenCalledTimes(1)
    const call = checkpoints.finish.mock.calls[0]!
    expect(call[0]).toBe(session)
    expect(call[1]).toEqual(input)
    expect(call[2]).toEqual(expect.any(String))
    expect(call[2].length).toBeGreaterThan(0)
    expect(call[3]).toMatchObject({ version: 1, type: 'result', result: request.result, transition: { revision: 3 } })
    expect(call[4]).toBe(signal)
    expect(call[5]).toEqual(expect.any(Function))
    const sealed = checkpoints.sealed.get(input.outputRef)!
    const closed = await store.readRun(session, target.id, started.runId)
    expect(closed.description).toEqual(open.description)
    expect(closed.result).toEqual({ ...sealed.prepared, version: 2, checkpoint: sealed.checkpoint })
    expect(closed.result).toHaveProperty('checkpoint', {
      backend: 'git',
      inputCommit: input.inputCommit,
      outputCommit: '4'.repeat(40),
      inputTree: input.inputTree,
      outputTree: '5'.repeat(40),
      inputRef: input.inputRef,
      outputRef: input.outputRef,
      objectFormat: 'sha1',
      codeChanged: true,
      artifacts: [{ path: 'result.json', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }],
    })
    expect(finished).toMatchObject({ runStatus: 'completed', state: { revision: 3, lastRunId: started.runId } })
    expect((await store.readTarget(session, target.id)).latestRun).toEqual(closed)
    const records = (await readFile(path.join(workspace, started.path), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(records).toEqual([closed.description, closed.result])
  })

  it('serializes starts from cwd aliases behind one checkpoint gate', async () => {
    const { store, session, target, checkpoints } = await fixture()
    const aliasedSession = testSession(workspace + '/.', 'test/session:alias')
    let releaseInput!: () => void
    let inputEntered!: () => void
    let aliasLockObserved!: () => void
    const inputGate = new Promise<void>(resolve => { releaseInput = resolve })
    const entered = new Promise<void>(resolve => { inputEntered = resolve })
    const observedAlias = new Promise<void>(resolve => { aliasLockObserved = resolve })
    const start = checkpoints.start.getMockImplementation()!
    checkpoints.start.mockImplementationOnce(async (...args) => {
      inputEntered()
      await inputGate
      return await start(...args)
    })
    // Observe lock selection, not timing: no sleeps or race-prone filesystem delays.
    const internal = store as unknown as { mutex: (session: ReturnType<typeof testSession>, id: string) => Promise<unknown> }
    const selectMutex = internal.mutex.bind(store)
    let primaryLock: unknown
    let aliasLock: unknown
    vi.spyOn(internal, 'mutex').mockImplementation(async (selectedSession, id) => {
      const lock = await selectMutex(selectedSession, id)
      if (selectedSession === session) primaryLock = lock
      if (selectedSession === aliasedSession) {
        aliasLock = lock
        aliasLockObserved()
      }
      return lock
    })
    const first = store.startRun(session, target.id, startRequest())
    await entered
    const second = store.startRun(aliasedSession, target.id, startRequest()).then(
      value => ({ value, error: undefined }),
      error => ({ value: undefined, error: error as unknown }),
    )
    await observedAlias
    releaseInput()
    const started = await first
    const rejected = await second
    expect(aliasLock).toBe(primaryLock)
    expect(rejected.value).toBeUndefined()
    expect(rejected.error).toMatchObject({ code: 'RESEARCH_RUN_OPEN' })
    expect(checkpoints.start).toHaveBeenCalledTimes(1)
    expect((await store.readRun(session, target.id, started.runId)).result).toBeUndefined()
    expect(await readdir(path.join(workspace, target.root, 'runs'))).toEqual([started.runId + '.jsonl'])
  })

  it.each(['active', 'paused', 'blocked', 'complete'] as const)('rejects %s state updates while a v2 run is open', async status => {
    const { store, session, target } = await fixture()
    const run = await store.startRun(session, target.id, startRequest())
    const before = await readFile(path.join(workspace, target.root, 'state.jsonl'), 'utf8')
    await expect(store.appendState(session, target.id, { status, summary: 'must not change a frozen base' }))
      .rejects.toMatchObject({ code: 'RESEARCH_RUN_OPEN' })
    expect(await readFile(path.join(workspace, target.root, 'state.jsonl'), 'utf8')).toBe(before)
    expect((await store.readRun(session, target.id, run.runId)).result).toBeUndefined()
  })

  it.each([
    ['missing reproduction', undefined],
    ['blank command', { command: ' ', cwd: '.', environment: {}, inputs: [] }],
    ['absolute cwd', { command: 'node run.mjs', cwd: '/tmp', environment: {}, inputs: [] }],
    ['escaping cwd', { command: 'node run.mjs', cwd: '../outside', environment: {}, inputs: [] }],
    ['missing environment', { command: 'node run.mjs', cwd: '.', inputs: [] }],
    ['missing inputs', { command: 'node run.mjs', cwd: '.', environment: {} }],
  ])('rejects %s before calling the checkpoint provider', async (_label, reproduction) => {
    const { store, session, target, checkpoints } = await fixture()
    await expect(store.startRun(session, target.id, { ...startRequest(), reproduction } as StartResearchRunRequest)).rejects.toThrow()
    expect(checkpoints.start).not.toHaveBeenCalled()
    expect(await readdir(path.join(workspace, target.root, 'runs'))).toEqual([])
    expect((await store.readTarget(session, target.id)).state.revision).toBe(1)
  })

  it('leaves state and run files untouched when the input checkpoint fails', async () => {
    const { store, session, target, checkpoints } = await fixture()
    checkpoints.start.mockRejectedValueOnce(new Error('simulated input checkpoint failure'))
    await expect(store.startRun(session, target.id, startRequest())).rejects.toThrow('simulated input checkpoint failure')
    expect(await readdir(path.join(workspace, target.root, 'runs'))).toEqual([])
    expect((await store.readTarget(session, target.id)).state.revision).toBe(1)
    await expect(store.startRun(session, target.id, startRequest())).resolves.toMatchObject({ researchId: target.id })
    expect(checkpoints.start).toHaveBeenCalledTimes(2)
  })

  it('leaves the run open and state unchanged when the output checkpoint fails', async () => {
    const { store, session, target, checkpoints } = await fixture()
    const run = await store.startRun(session, target.id, startRequest())
    const before = await readFile(path.join(workspace, run.path), 'utf8')
    checkpoints.finish.mockRejectedValueOnce(new Error('simulated output checkpoint failure'))
    const request = finishRequest(run.runId)
    await expect(store.finishRun(session, target.id, request)).rejects.toThrow('simulated output checkpoint failure')
    expect(await readFile(path.join(workspace, run.path), 'utf8')).toBe(before)
    expect((await store.readRun(session, target.id, run.runId)).result).toBeUndefined()
    expect((await store.readTarget(session, target.id)).state.revision).toBe(1)
    expect(checkpoints.sealed.size).toBe(0)
    await expect(store.startRun(session, target.id, startRequest())).rejects.toMatchObject({ code: 'RESEARCH_RUN_OPEN' })
    expect(checkpoints.start).toHaveBeenCalledTimes(1)
    await expect(store.finishRun(session, target.id, request)).resolves.toMatchObject({ state: { revision: 2 } })
  })

  it('rejects stale base state before creating an output checkpoint', async () => {
    const { store, session, target, checkpoints } = await fixture()
    const run = await store.startRun(session, target.id, startRequest())
    const stateFile = path.join(workspace, target.root, 'state.jsonl')
    const original = await readFile(stateFile, 'utf8')
    const externalState = { ...target.state, revision: 2, summary: 'external writer changed the frozen base' }
    await writeFile(stateFile, original + JSON.stringify(externalState) + '\n')
    await expect(store.finishRun(session, target.id, finishRequest(run.runId)))
      .rejects.toMatchObject({ code: 'RESEARCH_STALE_WRITE' })
    expect(checkpoints.finish).not.toHaveBeenCalled()
    expect((await store.readRun(session, target.id, run.runId)).result).toBeUndefined()
    expect((await store.readTarget(session, target.id)).state).toEqual(externalState)
  })

  it.each([
    ['invalid ordinary result', { result: ' ' }],
    ['oversized result', { result: 'x'.repeat(70_000) }],
    ['unloadable context', { summary: 'x'.repeat(40_000) }],
    ['non-lossless metrics', { metrics: { score: Number.NaN } }],
    ['escaping artifact', { artifacts: ['../outside.txt'] }],
  ])('preflights %s before sealing output', async (_label, override) => {
    const { store, session, target, checkpoints } = await fixture()
    const run = await store.startRun(session, target.id, startRequest())
    await expect(store.finishRun(session, target.id, { ...finishRequest(run.runId), ...override })).rejects.toThrow()
    expect(checkpoints.finish).not.toHaveBeenCalled()
    expect((await store.readRun(session, target.id, run.runId)).result).toBeUndefined()
    expect((await store.readTarget(session, target.id)).state.revision).toBe(1)
  })

  it('rejects expanded v2 metadata before the provider publishes its output journal', async () => {
    const { store, session, target, checkpoints } = await fixture()
    const run = await store.startRun(session, target.id, startRequest())
    const artifacts = Array.from({ length: 150 }, (_, index) => index + '-' + 'a'.repeat(180) + '.json')
    await Promise.all(artifacts.map(file => writeFile(path.join(workspace, file), '{}\n')))
    await expect(store.finishRun(session, target.id, { ...finishRequest(run.runId), artifacts }))
      .rejects.toMatchObject({ code: 'RESEARCH_OVERSIZED' })
    expect(checkpoints.finish).toHaveBeenCalledTimes(1)
    expect(checkpoints.sealed.size).toBe(0)
    expect((await store.readRun(session, target.id, run.runId)).result).toBeUndefined()
    expect((await store.readTarget(session, target.id)).state.revision).toBe(1)
    await expect(store.finishRun(session, target.id, finishRequest(run.runId))).resolves.toMatchObject({ state: { revision: 2 } })
  })

  it('does not publish when an artifact is missing before the first output seal', async () => {
    const { store, session, target, checkpoints } = await fixture()
    const run = await store.startRun(session, target.id, startRequest())
    const request = { ...finishRequest(run.runId), artifacts: ['missing.json'] }
    await expect(store.finishRun(session, target.id, request)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(checkpoints.finish).toHaveBeenCalledTimes(1)
    expect(checkpoints.sealed.size).toBe(0)
    expect((await store.readRun(session, target.id, run.runId)).result).toBeUndefined()
    expect((await store.readTarget(session, target.id)).state.revision).toBe(1)
    await writeFile(path.join(workspace, 'missing.json'), '{}\n')
    await expect(store.finishRun(session, target.id, request)).resolves.toMatchObject({ state: { revision: 2 } })
  })

  it('respects read-only refusal at start and at finish without changing the open run', async () => {
    const { ctx, store, session, target, checkpoints } = await fixture()
    const policy = vi.spyOn(ctx.sandboxPolicy, 'resolve').mockReturnValue({ mode: 'read-only', workspaceRoot: workspace })
    await expect(store.startRun(session, target.id, startRequest())).rejects.toThrow(/read-only/u)
    expect(checkpoints.start).not.toHaveBeenCalled()
    policy.mockRestore()
    const run = await store.startRun(session, target.id, startRequest())
    const before = await readFile(path.join(workspace, run.path), 'utf8')
    vi.spyOn(ctx.sandboxPolicy, 'resolve').mockReturnValue({ mode: 'read-only', workspaceRoot: workspace })
    // Exercise real provider policy enforcement, which precedes Git inspection.
    const readOnlyStore = new ResearchStore(ctx)
    await expect(readOnlyStore.finishRun(session, target.id, finishRequest(run.runId))).rejects.toThrow(/read-only/u)
    expect(await readFile(path.join(workspace, run.path), 'utf8')).toBe(before)
    expect((await store.readTarget(session, target.id)).state.revision).toBe(1)
  })

  it('recovers the original sealed payload after run publication fails and artifact files disappear', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
    const { ctx, store, session, target, checkpoints } = await fixture()
    const run = await store.startRun(session, target.id, startRequest())
    await writeFile(path.join(workspace, 'result.json'), '{"score":0.9}\n')
    const request = { ...finishRequest(run.runId), artifacts: ['result.json'] }
    const originalRun = await readFile(path.join(workspace, run.path), 'utf8')
    await failNextWrite(ctx, run.path, 'simulated run publication failure after output seal', 'replaceIfVersion')
    vi.setSystemTime(new Date('2025-01-02T00:00:00.000Z'))
    await expect(store.finishRun(session, target.id, request)).rejects.toThrow('simulated run publication failure')
    expect(await readFile(path.join(workspace, run.path), 'utf8')).toBe(originalRun)
    expect((await store.readRun(session, target.id, run.runId)).result).toBeUndefined()
    expect((await store.readTarget(session, target.id)).state.revision).toBe(1)
    const original = structuredClone([...checkpoints.sealed.values()][0]!)
    expect(original.prepared.finishedAt).toBe('2025-01-02T00:00:00.000Z')
    await expect(store.startRun(session, target.id, startRequest())).rejects.toMatchObject({ code: 'RESEARCH_RUN_OPEN' })
    expect(checkpoints.start).toHaveBeenCalledTimes(1)

    await rm(path.join(workspace, 'result.json'))
    vi.setSystemTime(new Date('2025-01-03T00:00:00.000Z'))
    const recoveredStore = new ResearchStore(ctx, checkpoints)
    const recovered = await recoveredStore.finishRun(session, target.id, request)
    expect(checkpoints.finish).toHaveBeenCalledTimes(2)
    expect(checkpoints.finish.mock.calls[1]![2]).toBe(checkpoints.finish.mock.calls[0]![2])
    expect(checkpoints.finish.mock.calls[1]![3].finishedAt).not.toBe(original.prepared.finishedAt)
    expect([...checkpoints.sealed.values()]).toEqual([original])
    const closed = await recoveredStore.readRun(session, target.id, run.runId)
    expect(closed.result).toEqual({ ...original.prepared, version: 2, checkpoint: original.checkpoint })
    expect(recovered.state).toEqual(original.prepared.transition)
    expect((await recoveredStore.finishRun(session, target.id, request)).state).toEqual(recovered.state)
    expect(checkpoints.finish).toHaveBeenCalledTimes(2)
    expect((await readFile(path.join(workspace, target.root, 'state.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2)
  })

  it('rejects a changed request after output seal without publishing a result or recapturing', async () => {
    const { ctx, store, session, target, checkpoints } = await fixture()
    const run = await store.startRun(session, target.id, startRequest())
    const request = finishRequest(run.runId)
    await failNextWrite(ctx, run.path, 'simulated run publication failure after output seal', 'replaceIfVersion')
    await expect(store.finishRun(session, target.id, request)).rejects.toThrow('simulated run publication failure')
    const original = structuredClone([...checkpoints.sealed.values()][0]!)
    await expect(store.finishRun(session, target.id, { ...request, result: 'a different result' }))
      .rejects.toMatchObject({ code: 'RESEARCH_RUN_CLOSED' })
    expect(checkpoints.finish.mock.calls[1]![2]).not.toBe(original.requestKey)
    expect([...checkpoints.sealed.values()]).toEqual([original])
    expect((await store.readRun(session, target.id, run.runId)).result).toBeUndefined()
    expect((await store.readTarget(session, target.id)).state.revision).toBe(1)
    await expect(store.finishRun(session, target.id, request)).resolves.toMatchObject({ state: { revision: 2 } })
  })

  const tamperedPayloads: [string, (prepared: Record<string, JsonValue>) => Record<string, JsonValue>][] = [
    ['result text', prepared => ({ ...prepared, result: 'a forged result' })],
    ['metrics', prepared => ({ ...prepared, metrics: { score: 99 } })],
    ['artifact list', prepared => ({ ...prepared, artifacts: ['not-requested.json'] })],
    ['state summary', prepared => ({ ...prepared, transition: { ...(prepared.transition as Record<string, JsonValue>), summary: 'forged state' } })],
    ['state revision', prepared => ({ ...prepared, transition: { ...(prepared.transition as Record<string, JsonValue>), revision: 99 } })],
    ['run reference', prepared => ({ ...prepared, transition: { ...(prepared.transition as Record<string, JsonValue>), lastRunId: '123e4567-e89b-42d3-a456-426614174099' } })],
    ['unknown payload field', prepared => ({ ...prepared, unexpected: true })],
  ]
  it.each(tamperedPayloads)('validates the provider-returned frozen %s before publication', async (_label, tamper) => {
    const { store, session, target, checkpoints } = await fixture()
    const run = await store.startRun(session, target.id, startRequest())
    const finish = checkpoints.finish.getMockImplementation()!
    checkpoints.finish.mockImplementation(async (...args) => {
      const sealed = await finish(...args)
      return { ...sealed, prepared: tamper(sealed.prepared) }
    })
    await expect(store.finishRun(session, target.id, finishRequest(run.runId))).rejects.toThrow()
    expect(checkpoints.finish).toHaveBeenCalledTimes(1)
    expect((await store.readRun(session, target.id, run.runId)).result).toBeUndefined()
    expect((await store.readTarget(session, target.id)).state.revision).toBe(1)
  })
})

describe('ResearchStore legacy v1 compatibility without Git', () => {
  it('reads and finishes manually written v1 runs with existing artifact and state semantics', async () => {
    // Default real backend in a directory with no .git: v1 must never invoke it.
    const store = new ResearchStore(testContext(workspace))
    const session = testSession(workspace)
    const target = await store.createTarget(session, { goal: 'Finish a pre-checkpoint run.', metrics: ['legacy compatibility'], baseline: 'v1' })
    const runId = parseRunId('123e4567-e89b-42d3-a456-426614174000')
    const description = {
      version: 1,
      type: 'description',
      createdAt: '2025-01-01T00:00:00.000Z',
      sessionId: String(session.id),
      purpose: 'legacy experiment created before checkpoints existed',
      parameters: { seed: 1, nested: { old: true } },
    }
    const runFile = path.join(workspace, target.root, 'runs', runId + '.jsonl')
    await writeFile(runFile, JSON.stringify(description) + '\n')
    expect(await store.readRun(session, target.id, runId)).toEqual({ id: runId, description })
    expect((await store.readTarget(session, target.id)).latestRun).toBeUndefined()
    await expect(store.startRun(session, target.id, startRequest())).rejects.toMatchObject({ code: 'RESEARCH_RUN_OPEN' })
    await store.appendState(session, target.id, { status: 'active', summary: 'legacy active updates remain supported' })
    const request = { ...finishRequest(runId), artifacts: ['legacy-result.json'] }
    await expect(store.finishRun(session, target.id, request)).rejects.toMatchObject({ code: 'RESEARCH_INVALID_RECORD' })
    expect((await store.readRun(session, target.id, runId)).result).toBeUndefined()
    await writeFile(path.join(workspace, 'legacy-result.json'), '{"score":0.9}\n')
    const finished = await store.finishRun(session, target.id, request)
    expect(finished).toMatchObject({ runStatus: 'completed', state: { revision: 3, lastRunId: runId } })
    const closed = await store.readRun(session, target.id, runId)
    expect(closed.description).toEqual(description)
    expect(closed.result).toMatchObject({ version: 1, status: 'completed', artifacts: ['legacy-result.json'] })
    expect(closed.result).not.toHaveProperty('checkpoint')
    expect((await store.readTarget(session, target.id)).latestRun).toEqual(closed)
    await rm(path.join(workspace, 'legacy-result.json'))
    const reopenedStore = new ResearchStore(testContext(workspace))
    expect(await reopenedStore.readRun(session, target.id, runId)).toEqual(closed)
    expect((await reopenedStore.finishRun(session, target.id, request)).state).toEqual(finished.state)
    await expect(reopenedStore.finishRun(session, target.id, { ...request, decision: 'rewrite legacy history' }))
      .rejects.toMatchObject({ code: 'RESEARCH_RUN_CLOSED' })
    await expect(stat(path.join(workspace, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
