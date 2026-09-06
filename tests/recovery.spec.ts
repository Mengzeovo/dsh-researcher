import { randomUUID } from 'node:crypto'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recoveryHost as host } from './recovery-helpers.ts'
import { buildResearchContext } from '../src/context.ts'
import { renderOpenRun } from '../src/jsonl.ts'
import { CONTEXT_MAX_CHARS, nowIso, parseRunId, researchRunDescriptionSchema } from '../src/schema.ts'
import { ResearchStore } from '../src/storage.ts'
import type { FinishResearchRunRequest } from '../src/types.ts'
import { failNextWrite, makeWorkspace, mockCheckpoints, removeWorkspace, testContext, testReproduction, testSession } from './helpers.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await removeWorkspace(root)
})

async function fixture(status: 'active' | 'paused' | 'blocked' | 'complete' = 'active') {
  const root = await makeWorkspace('researcher-recovery'); roots.push(root)
  const ctx = testContext(root)
  const checkpoints = mockCheckpoints()
  const store = new ResearchStore(ctx, checkpoints)
  const original = testSession(root, 'original-session')
  const target = await store.createTarget(original, { goal: 'Safely resume research publication', metrics: ['one exact result and state'], baseline: 'current revision' })
  if (status !== 'active') await store.appendState(original, target.id, { status, summary: 'Stopped before a historical run' })
  return { root, ctx, checkpoints, store, original, target: await store.readTarget(original, target.id) }
}

// Seed a v2 description directly: older versions allowed paused/blocked starts.
async function historicalRun(f: Awaited<ReturnType<typeof fixture>>) {
  const runId = parseRunId(randomUUID())
  const createdAt = nowIso()
  const checkpoint = await f.checkpoints.start(f.original, f.target.id, runId, createdAt, testReproduction())
  const description = researchRunDescriptionSchema.parse({
    version: 2, type: 'description', createdAt, sessionId: String(f.original.id),
    purpose: 'Historical execution', parameters: { seed: 7 }, baseStateRevision: f.target.state.revision, checkpoint,
  })
  const relative = `${f.target.root}/runs/${runId}.jsonl`
  await writeFile(path.join(f.root, relative), renderOpenRun(description))
  await writeFile(path.join(f.root, 'result.json'), '{"score":42}\n')
  const request: FinishResearchRunRequest = {
    runId, status: 'completed', result: 'Original result', metrics: { score: 42 }, decision: 'keep',
    artifacts: ['result.json'], researchStatus: f.target.state.status, summary: 'Original summary',
  }
  return { runId, relative, request, checkpoint }
}

describe('run recovery lifecycle', () => {
  it.each(['paused', 'blocked', 'complete'] as const)('rejects a new %s run before creating any checkpoint or record', async status => {
    const f = await fixture(status)
    const before = await readFile(path.join(f.root, f.target.root, 'state.jsonl'))
    await expect(f.store.startRun(f.original, f.target.id, { purpose: 'new run', parameters: {}, reproduction: testReproduction() }))
      .rejects.toMatchObject({ code: status === 'complete' ? 'RESEARCH_TARGET_COMPLETE' : 'RESEARCH_TARGET_INACTIVE' })
    expect(f.checkpoints.start).not.toHaveBeenCalled()
    expect(await readdir(path.join(f.root, f.target.root, 'runs'))).toEqual([])
    expect(await readFile(path.join(f.root, f.target.root, 'state.jsonl'))).toEqual(before)
  })

  describe.each(['active', 'paused', 'blocked'] as const)('%s target in a new session', status => {
    it.each(['open', 'output-sealed', 'pending-state'] as const)('loads %s without resuming state or Goal, then finishes exactly once', async phase => {
      const f = await fixture(status)
      const run = await historicalRun(f)
      const statePath = path.join(f.root, f.target.root, 'state.jsonl')
      const before = await readFile(statePath)
      if (phase !== 'open') {
        await failNextWrite(f.ctx, phase === 'output-sealed' ? run.relative : `${f.target.root}/state.jsonl`, 'interrupted publication', 'replaceIfVersion')
        await expect(f.store.finishRun(f.original, f.target.id, run.request)).rejects.toThrow('interrupted publication')
        await rm(path.join(f.root, 'result.json'))
      }
      const sealed = structuredClone([...f.checkpoints.sealed.values()])
      const fresh = host(f.ctx, new ResearchStore(f.ctx, f.checkpoints), f.root)
      const expectedRecovery = { runId: run.runId, phase: phase === 'pending-state' ? 'pending-state' : 'open', path: run.relative }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const loaded = await fresh.service.load(fresh.agent, f.target.id)
        expect(loaded.goalAction).toBe('recovery-only')
        expect(loaded.target.recovery).toMatchObject(expectedRecovery)
        expect(loaded.context.text).toContain(run.runId)
        expect(loaded.context.text).toContain('Recovery')
        expect(loaded.target.state).toEqual(f.target.state)
        expect(fresh.service.binding(fresh.session)?.researchId).toBe(f.target.id)
        expect((await fresh.service.get(fresh.agent)).target.recovery).toMatchObject(expectedRecovery)
        expect(await readFile(statePath)).toEqual(before)
      }
      for (const method of ['create', 'edit', 'resume', 'complete'] as const) expect(fresh.goals[method]).not.toHaveBeenCalled()
      if (phase !== 'open') {
        await expect(fresh.service.finishRun(fresh.agent, { ...run.request, result: 'changed result' })).rejects.toMatchObject({ code: 'RESEARCH_RUN_CLOSED' })
      }
      const finished = await fresh.service.finishRun(fresh.agent, run.request)
      expect(finished.state).toMatchObject({ revision: f.target.state.revision + 1, status, lastRunId: run.runId })
      if (phase !== 'open') {
        expect([...f.checkpoints.sealed.values()]).toEqual(sealed)
        expect(finished.state).toEqual(sealed[0]!.prepared.transition)
      }
      expect((await fresh.service.finishRun(fresh.agent, run.request)).state).toEqual(finished.state)
      expect((await fresh.service.get(fresh.agent)).target.recovery).toBeUndefined()
      expect(fresh.goals.create).not.toHaveBeenCalled()
      const loaded = await fresh.service.load(fresh.agent, f.target.id)
      expect(loaded.goalAction).toBe('created')
      expect(loaded.target.state.status).toBe('active')
      expect(loaded.target.state.revision).toBe(finished.state.revision + (status === 'active' ? 0 : 1))
      expect(fresh.goals.create).toHaveBeenCalledOnce()
    })
  })

  it('does not let exhausted matching Goal capacity prevent recovery binding', async () => {
    const f = await fixture('paused')
    const run = await historicalRun(f)
    const fresh = host(f.ctx, f.store, f.root, { id: 'goal-1', revision: 2, objective: `[researcher:${f.target.id}] existing`, phase: 'paused', activation: 'disarmed', roundsStarted: 3, maxGoalRounds: 3 })
    expect((await fresh.service.load(fresh.agent, f.target.id)).goalAction).toBe('recovery-only')
    expect(fresh.goals.resume).not.toHaveBeenCalled()
    await fresh.service.finishRun(fresh.agent, run.request)
    await expect(fresh.service.load(fresh.agent, f.target.id)).rejects.toMatchObject({ code: 'RESEARCH_GOAL_CONFLICT' })
  })

  it.each(['armed', 'disarmed'] as const)('leaves an existing matching %s Goal unchanged during recovery', async activation => {
    const f = await fixture()
    await historicalRun(f)
    const goal = { id: 'goal-1', revision: 2, objective: `[researcher:${f.target.id}] existing`, phase: 'active', activation, roundsStarted: 1, maxGoalRounds: 3 }
    const before = structuredClone(goal)
    const fresh = host(f.ctx, f.store, f.root, goal)
    expect((await fresh.service.load(fresh.agent, f.target.id)).goalAction).toBe('recovery-only')
    for (const method of ['create', 'edit', 'resume', 'complete'] as const) expect(fresh.goals[method]).not.toHaveBeenCalled()
    expect(fresh.goals.get()).toEqual(before)
  })

  it.each(['active', 'paused', 'blocked', 'complete'] as const)('recovers the original %s transition from the closed record rather than old target state', async researchStatus => {
    const f = await fixture('paused')
    const run = await historicalRun(f)
    const request = { ...run.request, researchStatus, summary: 'Prepared summary', direction: 'Prepared direction', next: 'Prepared next step' }
    await failNextWrite(f.ctx, `${f.target.root}/state.jsonl`, 'interrupted publication', 'replaceIfVersion')
    await expect(f.store.finishRun(f.original, f.target.id, request)).rejects.toThrow('interrupted publication')
    await rm(path.join(f.root, 'result.json'))
    const freshStore = new ResearchStore(f.ctx, f.checkpoints)
    const fresh = host(f.ctx, freshStore, f.root)
    const loaded = await fresh.service.load(fresh.agent, f.target.id)
    expect(loaded.goalAction).toBe('recovery-only')
    const recovery = loaded.target.recovery!
    const result = (await freshStore.readRun(fresh.session, f.target.id, recovery.runId)).result!
    const transition = result.transition
    const recovered = await fresh.service.finishRun(fresh.agent, {
      runId: recovery.runId, status: result.status, result: result.result, metrics: result.metrics,
      decision: result.decision, artifacts: result.artifacts, researchStatus: transition.status,
      summary: transition.summary, direction: transition.direction!, next: transition.next!,
    })
    expect(recovered.state).toEqual(transition)
    expect((await fresh.service.get(fresh.agent)).context.text).not.toContain('Recovery:')
    for (const method of ['create', 'edit', 'resume', 'complete'] as const) expect(fresh.goals[method]).not.toHaveBeenCalled()
    const resumed = await fresh.service.load(fresh.agent, f.target.id)
    expect(resumed.goalAction).toBe(researchStatus === 'complete' ? 'view-only' : 'created')
    expect(resumed.target.state.status).toBe(researchStatus === 'complete' ? 'complete' : 'active')
  })

  it('keeps an old near-limit context loadable and exposes recovery before optional glossary', async () => {
    const f = await fixture('paused')
    const binding = { version: 1 as const, researchId: f.target.id, sessionId: 'fresh-session', loadedAt: nowIso() }
    const initial = buildResearchContext(f.target, binding)
    const mandatoryLength = initial.sections.slice(0, 4).map(section => section.text).join('\n\n').length
    const statePath = path.join(f.root, f.target.root, 'state.jsonl')
    const records = (await readFile(statePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    records.at(-1).summary += 'x'.repeat(CONTEXT_MAX_CHARS - mandatoryLength)
    await writeFile(statePath, records.map(record => JSON.stringify(record)).join('\n') + '\n')
    await f.store.updateGlossary(f.original, f.target.id, { terms: { large: 'g'.repeat(40_000) } })
    const beforeRun = await f.store.readTarget(f.original, f.target.id)
    expect(buildResearchContext(beforeRun, binding).text.length).toBe(CONTEXT_MAX_CHARS)
    const run = await historicalRun(f)
    const before = await readFile(statePath)
    const fresh = host(f.ctx, f.store, f.root)
    const loaded = await fresh.service.load(fresh.agent, f.target.id)
    expect(loaded.goalAction).toBe('recovery-only')
    expect(loaded.context.text.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS)
    expect(loaded.context.sections.find(section => section.name === 'researcher:identity')?.text).toContain(`Recovery: open; run ${run.runId}`)
    expect(loaded.context.text).not.toContain('g'.repeat(100))
    expect(loaded.context.sections.find(section => section.name === 'researcher:goal')?.text).toBe(f.target.goal.markdown)
    expect((await fresh.service.get(fresh.agent)).target.recovery).toMatchObject({ runId: run.runId, path: run.relative, phase: 'open', outputRef: run.checkpoint.outputRef })
    expect(await readFile(statePath)).toEqual(before)
    await fresh.service.finishRun(fresh.agent, run.request)
  })

  it('recovers a paused legacy v1 run without calling the Git provider', async () => {
    const f = await fixture('paused')
    const runId = parseRunId(randomUUID())
    const relative = `${f.target.root}/runs/${runId}.jsonl`
    const description = researchRunDescriptionSchema.parse({ version: 1, type: 'description', createdAt: nowIso(), sessionId: String(f.original.id), purpose: 'Legacy execution', parameters: {} })
    await writeFile(path.join(f.root, relative), renderOpenRun(description))
    const fresh = host(f.ctx, f.store, f.root)
    const loaded = await fresh.service.load(fresh.agent, f.target.id)
    expect(loaded.goalAction).toBe('recovery-only')
    expect(loaded.target.recovery).toEqual({ runId, phase: 'open', path: relative })
    await fresh.service.finishRun(fresh.agent, { runId, status: 'failed', result: 'Execution failed', metrics: {}, decision: 'record failure', artifacts: [], researchStatus: 'paused', summary: 'Remain paused' })
    expect((await fresh.service.get(fresh.agent)).target.recovery).toBeUndefined()
    expect(f.checkpoints.start).not.toHaveBeenCalled()
    expect(f.checkpoints.finish).not.toHaveBeenCalled()
  })

  it('rejects ambiguous recovery candidates instead of selecting an arbitrary run', async () => {
    const f = await fixture()
    await historicalRun(f)
    await historicalRun(f)
    const fresh = host(f.ctx, f.store, f.root)
    await expect(fresh.service.load(fresh.agent, f.target.id)).rejects.toMatchObject({ code: 'RESEARCH_INVALID_RECORD' })
    expect(fresh.injected).not.toHaveBeenCalled()
  })

  it('still rejects a different unfinished Goal before recovery binding', async () => {
    const f = await fixture('paused')
    await historicalRun(f)
    const fresh = host(f.ctx, f.store, f.root, { id: 'other', objective: 'Unrelated objective', phase: 'active' })
    await expect(fresh.service.load(fresh.agent, f.target.id)).rejects.toMatchObject({ code: 'RESEARCH_GOAL_CONFLICT' })
    expect(fresh.injected).not.toHaveBeenCalled()
    expect(fresh.service.binding(fresh.session)).toBeUndefined()
  })
})
