import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResearcherError } from '../src/errors.ts'
import { parseJsonText, researchSessionIndexSchema } from '../src/schema.ts'
import { ResearchStore } from '../src/storage.ts'
import { makeWorkspace, removeWorkspace, testContext, testSession } from './helpers.ts'

let workspace: string

beforeEach(async () => {
  workspace = await makeWorkspace('dsh-researcher-store')
})

afterEach(async () => {
  await removeWorkspace(workspace)
})

describe('ResearchStore integration', () => {
  it('creates the exact staged target layout and lists it', async () => {
    const store = new ResearchStore(testContext(workspace))
    const session = testSession(workspace)
    const target = await store.createTarget(session, {
      goal: 'Compare candidate A against the baseline.',
      metrics: ['throughput improves', 'latency does not regress'],
      baseline: 'candidate B',
      direction: 'establish the baseline first',
      next: 'run seed 1',
    })

    expect(target.state.revision).toBe(1)
    expect(target.state.status).toBe('active')
    expect(target.goal.description).toBe('Compare candidate A against the baseline.')
    expect(await readFile(path.join(workspace, target.goalPath), 'utf8')).toContain('## Metrics')
    expect(await readFile(path.join(workspace, target.root, 'glossary.json'), 'utf8')).toContain('"version": 1')
    expect(await readFile(path.join(workspace, target.root, 'session', 'dGVzdC9zZXNzaW9uOjE.json'), 'utf8')).toContain('test/session:1')
    const stateText = await readFile(path.join(workspace, target.root, 'state.jsonl'), 'utf8')
    expect(stateText).toContain('"revision":1')
    expect(stateText.endsWith('\n')).toBe(true)
    expect(stateText.trim().split('\n')).toHaveLength(1)

    const listed = await store.listTargets(session)
    expect(listed.targets).toHaveLength(1)
    expect(listed.targets[0]).toMatchObject({ id: target.id, status: 'active', warningCount: 0 })
    expect(listed.invalid).toEqual([])
    await expect((await import('node:fs/promises')).readdir(path.join(workspace, '.research/goal'))).resolves.not.toContain(`.creating-${target.id}`)
  })

  it('enforces one open run, closes it immutably, and appends its state', async () => {
    const store = new ResearchStore(testContext(workspace))
    const session = testSession(workspace)
    const target = await store.createTarget(session, {
      goal: 'Run one controlled experiment.',
      metrics: ['score >= baseline'],
      baseline: 'score = 1',
    })
    const started = await store.startRun(session, target.id, {
      purpose: 'seed 7 baseline',
      parameters: { seed: 7, nested: { mode: 'baseline' } },
    })

    await expect(store.startRun(session, target.id, {
      purpose: 'must wait',
      parameters: {},
    })).rejects.toMatchObject({ code: 'RESEARCH_RUN_OPEN' })
    await expect(store.appendState(session, target.id, {
      status: 'active',
      summary: 'must not point state at an open run',
      lastRunId: started.runId,
    })).rejects.toMatchObject({ code: 'RESEARCH_INVALID_RECORD' })
    await expect(store.appendState(session, target.id, {
      status: 'complete',
      summary: 'must not strand the open run',
    })).rejects.toMatchObject({ code: 'RESEARCH_RUN_OPEN' })

    await mkdir(path.join(workspace, 'results'))
    await writeFile(path.join(workspace, 'results', 'seed-7.json'), '{"score":0.9}\n')
    const request = {
      runId: started.runId,
      status: 'completed' as const,
      result: 'The candidate was below baseline; this is a valid negative scientific result.',
      metrics: { score: 0.9 },
      decision: 'change the method',
      artifacts: ['results/seed-7.json'],
      researchStatus: 'active' as const,
      summary: 'Seed 7 did not beat the baseline.',
      direction: 'try candidate C',
      next: 'run seed 8',
    }
    const finished = await store.finishRun(session, target.id, request)
    expect(finished.runStatus).toBe('completed')
    expect(finished.state).toMatchObject({ revision: 2, lastRunId: started.runId, status: 'active' })

    const closed = await store.readRun(session, target.id, started.runId)
    expect(closed.result).toMatchObject({ status: 'completed', result: request.result })
    expect((await store.finishRun(session, target.id, request)).state.revision).toBe(2)
    await expect(store.finishRun(session, target.id, { ...request, result: 'different immutable result' }))
      .rejects.toMatchObject({ code: 'RESEARCH_RUN_CLOSED' })

    const next = await store.startRun(session, target.id, { purpose: 'seed 8', parameters: { seed: 8 } })
    expect(next.runId).not.toBe(started.runId)

    const encoded = 'dGVzdC9zZXNzaW9uOjE'
    const indexText = await readFile(path.join(workspace, target.root, 'session', `${encoded}.json`), 'utf8')
    const index = parseJsonText('session index', indexText, researchSessionIndexSchema, 1024 * 1024)
    expect(index.runIds).toEqual([started.runId, next.runId])
  })

  it('recovers an interrupted finish exactly once and never replays it over newer state', async () => {
    const store = new ResearchStore(testContext(workspace))
    const session = testSession(workspace)
    const target = await store.createTarget(session, {
      goal: 'Recover a two-file run finish.',
      metrics: ['one exact transition is published'],
      baseline: 'open run',
    })
    const started = await store.startRun(session, target.id, { purpose: 'recoverable run', parameters: {} })
    await mkdir(path.join(workspace, 'results'))
    const artifact = path.join(workspace, 'results', 'recover.json')
    await writeFile(artifact, '{"ok":true}\n')
    const request = {
      runId: started.runId,
      status: 'completed' as const,
      result: 'finished before state publication',
      metrics: { ok: true },
      decision: 'continue',
      artifacts: ['results/recover.json'],
      researchStatus: 'active' as const,
      summary: 'recover the prepared transition',
      next: 'start the next run',
    }

    const internal = store as unknown as {
      replaceText: (...args: unknown[]) => Promise<void>
    }
    const originalReplace = internal.replaceText.bind(store)
    let failStateOnce = true
    vi.spyOn(internal, 'replaceText').mockImplementation(async (...args: unknown[]) => {
      if (failStateOnce && args[2] === `${target.root}/state.jsonl`) {
        failStateOnce = false
        throw new Error('simulated state publication failure')
      }
      await originalReplace(...args)
    })

    await expect(store.finishRun(session, target.id, request)).rejects.toThrow(/simulated state publication failure/u)
    expect((await store.readRun(session, target.id, started.runId)).result?.transition.revision).toBe(2)
    expect((await store.readTarget(session, target.id)).state.revision).toBe(1)

    await rm(artifact)
    const recovered = await store.finishRun(session, target.id, request)
    expect(recovered.state).toMatchObject({ revision: 2, lastRunId: started.runId })

    const newer = await store.startRun(session, target.id, { purpose: 'newer run', parameters: {} })
    await writeFile(path.join(workspace, 'results', 'newer.json'), '{}\n')
    await store.finishRun(session, target.id, {
      ...request,
      runId: newer.runId,
      result: 'newer result',
      artifacts: ['results/newer.json'],
      summary: 'newer state must win',
    })
    await expect(store.finishRun(session, target.id, request))
      .rejects.toMatchObject({ code: 'RESEARCH_STALE_WRITE' })
    expect((await store.readTarget(session, target.id)).state.summary).toBe('newer state must win')
  })

  it('patches glossary records, validates paths, and reports missing relevant files', async () => {
    const store = new ResearchStore(testContext(workspace))
    const session = testSession(workspace)
    const target = await store.createTarget(session, {
      goal: 'Maintain only goal-relevant terminology.',
      metrics: ['glossary is precise'],
      baseline: 'empty glossary',
    })
    await mkdir(path.join(workspace, 'src'))
    await writeFile(path.join(workspace, 'src', 'model.cc'), '// model\n')

    const update = await store.updateGlossary(session, target.id, {
      terms: { KPI: 'primary success metric' },
      files: {
        'src/model.cc': 'candidate implementation',
        'results/missing.json': 'expected result artifact',
      },
    })
    expect(update).toMatchObject({ termCount: 1, fileCount: 2 })
    const reread = await store.readTarget(session, target.id)
    expect(reread.glossary.terms.KPI).toBe('primary success metric')
    expect(reread.warnings).toEqual(['glossary file is missing: results/missing.json'])

    await store.updateGlossary(session, target.id, {
      terms: { KPI: null },
      files: { 'src\\model.cc': 'canonicalized candidate implementation' },
    })
    const canonicalized = await store.readTarget(session, target.id)
    expect(canonicalized.glossary.terms).toEqual({})
    expect(canonicalized.glossary.files['src/model.cc']).toBe('canonicalized candidate implementation')
    await expect(store.updateGlossary(session, target.id, { files: { '../escape': 'bad' } }))
      .rejects.toMatchObject({ code: 'RESEARCH_PATH_INVALID' })

    const outside = await makeWorkspace('dsh-researcher-glossary-outside')
    try {
      await writeFile(path.join(outside, 'external.txt'), 'outside\n')
      await symlink(outside, path.join(workspace, 'outside-link'), 'dir')
      await expect(store.updateGlossary(session, target.id, {
        files: { 'outside-link/external.txt': 'must not escape canonically' },
      })).rejects.toMatchObject({ code: 'RESEARCH_PATH_INVALID' })
      expect((await store.readTarget(session, target.id)).glossary.files['outside-link/external.txt']).toBeUndefined()
    } finally {
      await removeWorkspace(outside)
    }
  })

  it('resumes paused state and treats complete as terminal', async () => {
    const store = new ResearchStore(testContext(workspace))
    const session = testSession(workspace)
    const target = await store.createTarget(session, {
      goal: 'Exercise lifecycle transitions.',
      metrics: ['state is append-only'],
      baseline: 'active revision 1',
    })
    await store.appendState(session, target.id, { status: 'paused', summary: 'waiting for data', next: 'load data' })
    const resumed = await store.resumeState(session, target.id)
    expect(resumed.state).toMatchObject({ status: 'active', revision: 3, summary: 'waiting for data' })
    await store.appendState(session, target.id, { status: 'complete', summary: 'all criteria met' })
    await expect(store.appendState(session, target.id, { status: 'active', summary: 'reopen' }))
      .rejects.toMatchObject({ code: 'RESEARCH_TARGET_COMPLETE' })
    await expect(store.startRun(session, target.id, { purpose: 'late run', parameters: {} }))
      .rejects.toMatchObject({ code: 'RESEARCH_TARGET_COMPLETE' })
  })

  it('rejects unloadable create, state, and finish transitions before publication', async () => {
    const store = new ResearchStore(testContext(workspace))
    const session = testSession(workspace)
    await expect(store.createTarget(session, {
      goal: 'x'.repeat(40_000),
      metrics: ['bounded'],
      baseline: 'small',
    })).rejects.toMatchObject({ code: 'RESEARCH_OVERSIZED' })
    await expect((await import('node:fs/promises')).stat(path.join(workspace, '.research')))
      .rejects.toMatchObject({ code: 'ENOENT' })

    const target = await store.createTarget(session, {
      goal: 'Keep every committed state loadable.',
      metrics: ['context <= 32 KiB'],
      baseline: 'revision 1',
    })
    await expect(store.appendState(session, target.id, {
      status: 'complete',
      summary: 'x'.repeat(40_000),
    })).rejects.toMatchObject({ code: 'RESEARCH_OVERSIZED' })
    expect((await store.readTarget(session, target.id)).state).toMatchObject({ revision: 1, status: 'active' })

    const run = await store.startRun(session, target.id, { purpose: 'oversized finish', parameters: {} })
    await expect(store.finishRun(session, target.id, {
      runId: run.runId,
      status: 'completed',
      result: 'valid result',
      metrics: {},
      decision: 'must not publish',
      artifacts: [],
      researchStatus: 'complete',
      summary: 'x'.repeat(40_000),
    })).rejects.toMatchObject({ code: 'RESEARCH_OVERSIZED' })
    expect((await store.readRun(session, target.id, run.runId)).result).toBeUndefined()
    expect((await store.readTarget(session, target.id)).state.revision).toBe(1)
  })

  it('isolates invalid targets and rejects authority-file symlinks', async () => {
    const store = new ResearchStore(testContext(workspace))
    const session = testSession(workspace)
    const valid = await store.createTarget(session, {
      goal: 'Keep valid records visible.',
      metrics: ['list is resilient'],
      baseline: 'one target',
    })
    const brokenId = '123e4567-e89b-42d3-a456-426614174099'
    await mkdir(path.join(workspace, '.research', 'goal', brokenId))
    const listed = await store.listTargets(session)
    expect(listed.targets.map(item => item.id)).toEqual([valid.id])
    expect(listed.invalid).toHaveLength(1)
    expect(listed.invalid[0]).toMatchObject({ id: brokenId })

    const second = await store.createTarget(session, {
      goal: 'Protect this target from cross-target symlinks.',
      metrics: ['state is isolated'],
      baseline: 'revision 1',
    })
    const firstState = path.join(workspace, valid.root, 'state.jsonl')
    const secondState = path.join(workspace, second.root, 'state.jsonl')
    await rm(firstState)
    await symlink(secondState, firstState, 'file')
    await expect(store.readTarget(session, valid.id)).rejects.toMatchObject({ code: 'RESEARCH_PATH_INVALID' })
    await expect(store.appendState(session, valid.id, { status: 'active', summary: 'must not redirect' }))
      .rejects.toMatchObject({ code: 'RESEARCH_PATH_INVALID' })
    expect((await store.readTarget(session, second.id)).state.revision).toBe(1)

    const other = await makeWorkspace('dsh-researcher-outside')
    try {
      const linkedWorkspace = await makeWorkspace('dsh-researcher-link')
      try {
        await mkdir(path.join(other, 'goal'))
        await symlink(other, path.join(linkedWorkspace, '.research'), 'dir')
        const linkedStore = new ResearchStore(testContext(linkedWorkspace))
        await expect(linkedStore.listTargets(testSession(linkedWorkspace)))
          .rejects.toBeInstanceOf(ResearcherError)
      } finally {
        await removeWorkspace(linkedWorkspace)
      }
    } finally {
      await removeWorkspace(other)
    }
  })
})
