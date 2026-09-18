import { describe, expect, it } from 'vitest'
import { parseRunId, reproductionSchema, researchPreparedRunResultSchema, researchRunDescriptionSchema, researchRunResultSchema } from '../src/schema.ts'
import { parseRunLog } from '../src/jsonl.ts'

const id = parseRunId('123e4567-e89b-42d3-b456-426614174001')
const ref = `refs/dsh/research/123e4567-e89b-42d3-b456-426614174002/runs/${id}`
const at = '2026-09-05T00:00:00.000Z'
function fixture() {
  const input = {
    backend: 'git', inputRef: `${ref}/input`, outputRef: `${ref}/output`,
    inputCommit: '1'.repeat(40), inputTree: '2'.repeat(40), baseHead: '3'.repeat(40),
    objectFormat: 'sha1', files: ['main.py'],
    reproduction: { command: 'python main.py', cwd: '.', inputs: [], environment: { python: '3.12' } },
  }
  const description = { version: 2, type: 'description', createdAt: at, sessionId: 'session', purpose: 'baseline', parameters: { seed: 7 }, baseStateRevision: 1, checkpoint: input }
  const checkpoint = { backend: 'git', inputRef: input.inputRef, outputRef: input.outputRef, inputCommit: input.inputCommit, inputTree: input.inputTree, outputCommit: '4'.repeat(40), outputTree: input.inputTree, objectFormat: 'sha1', artifacts: [{ path: 'out.json', sha256: '5'.repeat(64), bytes: 8 }], codeChanged: false }
  const result = { version: 2, type: 'result', finishedAt: at, status: 'completed', result: 'negative result', metrics: { score: 0.9 }, decision: 'continue', artifacts: ['out.json'], transition: { version: 1, revision: 2, at, sessionId: 'session', status: 'active', summary: 'recorded', lastRunId: id }, checkpoint }
  return { description, result }
}
function text(description: unknown, result?: unknown) {
  return [description, ...(result === undefined ? [] : [result])].map(value => JSON.stringify(value)).join('\n') + '\n'
}

describe('checkpoint record validation', () => {
  it('validates explicit scope, digests and acknowledgements without defaulting old recipes', () => {
    const { description } = fixture()
    const base = description.checkpoint.reproduction
    const snapshot = { mode: 'scoped', paths: ['src'], externalInputs: [{ path: 'data.bin', bytes: 3, sha256: 'a'.repeat(64) }] }
    expect(reproductionSchema.parse(base)).toEqual(base)
    expect(reproductionSchema.parse({ ...base, snapshot })).toEqual({ ...base, snapshot })
    for (const paths of [[], ['src', 'src'], ['src', 'src/a.ts'], ['.'], ['src/'], ['../src'], ['.git'], ['.research']]) {
      expect(reproductionSchema.safeParse({ ...base, snapshot: { ...snapshot, paths } }).success).toBe(false)
    }
    expect(reproductionSchema.safeParse({ ...base, inputs: ['data.bin'], snapshot }).success).toBe(false)
    for (const bytes of [-1, 1.5, 1024 * 1024 * 1024 + 1]) {
      expect(reproductionSchema.safeParse({ ...base, snapshot: { ...snapshot, externalInputs: [{ ...snapshot.externalInputs[0], bytes }] } }).success).toBe(false)
    }
  })

  it('binds scoped markers, deletion population, base identity and explicit omitted changes in v3 records', () => {
    const old = fixture()
    const planRef = { planId: 3, revision: 5, sha256: 'a'.repeat(64) }
    const description = { ...old.description, version: 3, planRef, checkpoint: { ...old.description.checkpoint,
      reproduction: { ...old.description.checkpoint.reproduction, snapshot: { mode: 'scoped', paths: ['main.py'] } },
      snapshot: { mode: 'scoped-overlay', deleted: [], omittedChanges: [] },
    } }
    const result = { ...old.result, version: 3, planRef, transition: { ...old.result.transition, version: 2, selectedPlanRef: planRef },
      checkpoint: { ...old.result.checkpoint, snapshot: { mode: 'scoped-overlay', baseHead: description.checkpoint.baseHead, deleted: [] } },
    }
    expect(parseRunLog(id, text(description, result)).result).toEqual(result)
    const { snapshot: _marker, ...unmarked } = description.checkpoint
    expect(researchRunDescriptionSchema.safeParse({ ...description, checkpoint: unmarked }).success).toBe(false)
    const { snapshot: _recipe, ...unscoped } = description.checkpoint.reproduction
    expect(researchRunDescriptionSchema.safeParse({ ...description, checkpoint: { ...description.checkpoint, reproduction: unscoped } }).success).toBe(false)
    for (const snapshot of [
      { ...description.checkpoint.snapshot, deleted: ['unfrozen.py'] },
      { ...description.checkpoint.snapshot, omittedChanges: ['unreviewed.py'] },
    ]) expect(researchRunDescriptionSchema.safeParse({ ...description, checkpoint: { ...description.checkpoint, snapshot } }).success).toBe(false)
    for (const snapshot of [
      undefined,
      { ...result.checkpoint.snapshot, baseHead: '9'.repeat(40) },
      { ...result.checkpoint.snapshot, deleted: ['unfrozen.py'] },
    ]) expect(() => parseRunLog(id, text(description, { ...result, checkpoint: { ...result.checkpoint, snapshot } }))).toThrow()
    expect(researchRunDescriptionSchema.safeParse({ ...old.description, checkpoint: description.checkpoint }).success).toBe(false)
  })

  it('accepts complete v2 pairs and rejects fabricated version mixing', () => {
    const { description, result } = fixture()
    expect(parseRunLog(id, text(description, result)).description.version).toBe(2)
    const { checkpoint: _checkpoint, ...fields } = result
    expect(() => parseRunLog(id, text(description, { ...fields, version: 1 }))).toThrow(/versions disagree/u)
  })
  it('preserves legacy records and permits a first legacy finish with supported newer state', () => {
    const { description, result } = fixture()
    const original = parseRunLog(id, text(description, result))
    expect(original.description).toEqual(description)
    expect(original.result).toEqual(result)
    const { checkpoint: _checkpoint, ...legacyPrepared } = result
    const prepared = { ...legacyPrepared, version: 1 }
    expect(researchPreparedRunResultSchema.parse(prepared)).toEqual(prepared)
    expect(researchPreparedRunResultSchema.parse(prepared).transition.version).toBe(1)
    const selectedPlanRef = { planId: 1, revision: 1, sha256: 'a'.repeat(64) }
    const supported = { ...result, transition: { ...result.transition, version: 2, selectedPlanRef } }
    const closed = parseRunLog(id, text(description, supported))
    expect(closed.result).toEqual(supported)
    expect(closed.description).not.toHaveProperty('planRef')
    expect(closed.result).not.toHaveProperty('planRef')
    expect(researchRunDescriptionSchema.safeParse({ ...description, planRef: selectedPlanRef }).success).toBe(false)
    expect(researchRunResultSchema.safeParse({ ...result, planRef: selectedPlanRef }).success).toBe(false)
  })
  it('validates recipe paths, required fields and JSON metadata', () => {
    const { description } = fixture()
    expect(reproductionSchema.parse(description.checkpoint.reproduction).cwd).toBe('.')
    for (const cwd of ['/tmp', '../parent', '.git', 'a/../b', 'a\u0000b']) {
      expect(reproductionSchema.safeParse({ ...description.checkpoint.reproduction, cwd }).success).toBe(false)
    }
    expect(reproductionSchema.safeParse({ command: 'x' }).success).toBe(false)
    expect(reproductionSchema.safeParse({ ...description.checkpoint.reproduction, inputs: ['a', 'a'] }).success).toBe(false)
    expect(reproductionSchema.safeParse({ ...description.checkpoint.reproduction, environment: { value: NaN } }).success).toBe(false)
  })
  it('binds refs, objects, digests and the prepared state to the input run', () => {
    const { description, result } = fixture()
    expect(() => parseRunLog(id, text(description, { ...result, checkpoint: { ...result.checkpoint, inputCommit: '6'.repeat(40) } }))).toThrow(/identity/u)
    expect(() => parseRunLog(id, text(description, { ...result, transition: { ...result.transition, revision: 3 } }))).toThrow(/transition/u)
    expect(() => parseRunLog(id, text(description, { ...result, checkpoint: { ...result.checkpoint, codeChanged: true } }))).toThrow(/identity/u)
    expect(() => parseRunLog(id, text(description, { ...result, checkpoint: { ...result.checkpoint, outputCommit: '6'.repeat(64) } }))).toThrow(/format/u)
    expect(() => parseRunLog(id, text({ ...description, checkpoint: { ...description.checkpoint, inputRef: `${ref}/other` } }))).toThrow()
    expect(researchRunResultSchema.safeParse({ ...result, artifacts: ['different.json'] }).success).toBe(false)
    expect(researchRunResultSchema.safeParse({ ...result, checkpoint: { ...result.checkpoint, artifacts: [{ path: 'out.json', sha256: 'invalid', bytes: -1 }] } }).success).toBe(false)
  })
})
