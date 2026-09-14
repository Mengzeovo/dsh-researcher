import { describe, expect, it } from 'vitest'
import { appendStateText, parseRunLog, parseStateLog } from '../src/jsonl.ts'
import {
  parseRunId, researchPreparedRunResultSchema, researchRunDescriptionSchema,
  researchRunResultSchema, researchStateSchema,
} from '../src/schema.ts'
import { isCheckpointRunDescription, isCheckpointRunResult, samePlanVersionRef } from '../src/types.ts'
import type { ResearchRunDescription, ResearchRunResult } from '../src/types.ts'

const runId = parseRunId('123e4567-e89b-42d3-b456-426614174001')
const ref = `refs/dsh/research/123e4567-e89b-42d3-b456-426614174002/runs/${runId}`
const at = '2026-09-05T00:00:00.000Z'
const planRef = { planId: 7, revision: 2, sha256: 'a'.repeat(64) }
const stateV1 = { version: 1, revision: 1, at, sessionId: 'original', status: 'active', summary: 'legacy' }
function fixture() {
  const checkpoint = {
    backend: 'git', inputRef: ref + '/input', outputRef: ref + '/output',
    inputCommit: '1'.repeat(40), inputTree: '2'.repeat(40), baseHead: '3'.repeat(40),
    objectFormat: 'sha1', files: ['main.py'],
    reproduction: { command: 'python main.py', cwd: '.', inputs: [], environment: {} },
  }
  const description = { version: 3, type: 'description', createdAt: at, sessionId: 'original', purpose: 'baseline', parameters: {}, baseStateRevision: 1, checkpoint, planRef }
  const prepared = {
    version: 3, type: 'result', finishedAt: at, status: 'completed', result: 'negative result', metrics: { score: 0.9 },
    decision: 'continue', artifacts: ['out.json'], planRef,
    transition: { ...stateV1, version: 2, revision: 2, lastRunId: runId, selectedPlanRef: planRef },
  }
  const result = { ...prepared, checkpoint: {
    backend: 'git', inputRef: checkpoint.inputRef, outputRef: checkpoint.outputRef,
    inputCommit: checkpoint.inputCommit, inputTree: checkpoint.inputTree,
    outputCommit: '4'.repeat(40), outputTree: checkpoint.inputTree, objectFormat: 'sha1', codeChanged: false,
    artifacts: [{ path: 'out.json', sha256: '5'.repeat(64), bytes: 8 }],
  } }
  return { description, prepared, result }
}
const text = (...records: unknown[]) => records.map(value => JSON.stringify(value)).join('\n') + '\n'

describe('plan-aware state and run schemas', () => {
  it('reads legacy state without upgrades and preserves its source bytes in mixed logs', () => {
    const first = JSON.stringify(stateV1, null, 0).replace(':1,', ': 1,') + '\n'
    const legacy = parseStateLog(first)
    expect(legacy.states[0]).toEqual(stateV1)
    expect(legacy.states[0]).not.toHaveProperty('selectedPlanRef')
    const selected = researchStateSchema.parse({ ...stateV1, version: 2, revision: 2, selectedPlanRef: planRef })
    const appended = appendStateText(legacy, selected)
    expect(appended.startsWith(first)).toBe(true)
    expect(parseStateLog(appended).states).toEqual([stateV1, selected])
    expect(researchStateSchema.parse({ ...stateV1, version: 2 })).not.toHaveProperty('selectedPlanRef')
    expect(researchStateSchema.safeParse({ ...stateV1, selectedPlanRef: planRef }).success).toBe(false)
  })

  it.each([
    { planId: 0 }, { planId: -1 }, { planId: 1.5 }, { planId: Number.MAX_SAFE_INTEGER + 1 },
    { revision: 0 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { sha256: 'A'.repeat(64) }, { sha256: 'short' }, { unknown: true },
  ])('rejects malformed selected references %j', patch => {
    expect(researchStateSchema.safeParse({ ...stateV1, version: 2, selectedPlanRef: { ...planRef, ...patch } }).success).toBe(false)
  })

  it('keeps incomplete-tail recovery and revision/terminal checks across state versions', () => {
    const selected = { ...stateV1, version: 2, revision: 2, selectedPlanRef: planRef }
    expect(parseStateLog(text(stateV1, selected) + '{"version":2').warning).toMatch(/incomplete/u)
    expect(() => parseStateLog(text(stateV1, { ...selected, revision: 3 }))).toThrow(/expected 2/u)
    expect(() => parseStateLog(text({ ...stateV1, status: 'complete' }, selected))).toThrow(/terminal/u)
    expect(researchStateSchema.safeParse({ ...selected, version: 3 }).success).toBe(false)
  })

  it('accepts v3 pairs and independent prepared payloads without a self-referential checkpoint', () => {
    const { description, prepared, result } = fixture()
    const run = parseRunLog(runId, text(description, result))
    expect(run).toEqual({ id: runId, description, result })
    expect(researchPreparedRunResultSchema.parse(prepared)).toEqual(prepared)
    expect(researchPreparedRunResultSchema.safeParse(result).success).toBe(false)
    expect(researchRunResultSchema.safeParse(prepared).success).toBe(false)
    expect(isCheckpointRunDescription(run.description)).toBe(true)
    expect(isCheckpointRunResult(run.result!)).toBe(true)
    expect(isCheckpointRunDescription({ ...run.description, version: 4 } as unknown as ResearchRunDescription)).toBe(false)
    expect(isCheckpointRunResult({ ...run.result!, version: 4 } as unknown as ResearchRunResult)).toBe(false)
  })

  it('requires a plan and the selected v2 transition for every v3 result', () => {
    const { description, prepared, result } = fixture()
    const { planRef: _descriptionPlan, ...unplannedDescription } = description
    const { planRef: _resultPlan, ...unplannedResult } = result
    const { selectedPlanRef: _selection, ...unselected } = prepared.transition
    expect(researchRunDescriptionSchema.safeParse(unplannedDescription).success).toBe(false)
    expect(researchRunResultSchema.safeParse(unplannedResult).success).toBe(false)
    expect(researchPreparedRunResultSchema.safeParse({ ...prepared, transition: unselected }).success).toBe(false)
    expect(researchPreparedRunResultSchema.safeParse({ ...prepared, transition: { ...unselected, version: 1 } }).success).toBe(false)
    expect(researchPreparedRunResultSchema.safeParse({ ...prepared, version: 2 }).success).toBe(false)
  })

  it.each([{ planId: 8 }, { revision: 3 }, { sha256: 'b'.repeat(64) }])('rejects a changed pin component %j', patch => {
    const { description, prepared, result } = fixture()
    const changed = { ...planRef, ...patch }
    expect(samePlanVersionRef(planRef, changed)).toBe(false)
    expect(researchPreparedRunResultSchema.safeParse({ ...prepared, planRef: changed }).success).toBe(false)
    const coherentButDifferent = { ...result, planRef: changed, transition: { ...result.transition, selectedPlanRef: changed } }
    expect(() => parseRunLog(runId, text(description, coherentButDifferent))).toThrow(/plan reference/u)
  })

  it('applies existing checkpoint and base-state invariants to v3 instead of falling through v2 branches', () => {
    const { description, result } = fixture()
    expect(() => parseRunLog(runId, text(description, { ...result, transition: { ...result.transition, revision: 3 } }))).toThrow(/transition/u)
    expect(() => parseRunLog(runId, text(description, { ...result, transition: { ...result.transition, lastRunId: '123e4567-e89b-42d3-b456-426614174099' } }))).toThrow(/transition/u)
    expect(() => parseRunLog(runId, text(description, { ...result, checkpoint: { ...result.checkpoint, inputCommit: '6'.repeat(40) } }))).toThrow(/identity/u)
    expect(() => parseRunLog(runId, text(description, { ...result, checkpoint: { ...result.checkpoint, outputCommit: '6'.repeat(64) } }))).toThrow(/format/u)
    expect(() => parseRunLog(runId, text(description, { ...result, checkpoint: { ...result.checkpoint, codeChanged: true } }))).toThrow(/identity/u)
    expect(() => parseRunLog(runId, text({ ...description, checkpoint: { ...description.checkpoint, inputRef: ref.replace(runId, '123e4567-e89b-42d3-b456-426614174099') + '/input' } }))).toThrow(/refs/u)
    expect(researchRunResultSchema.safeParse({ ...result, artifacts: ['other.json'] }).success).toBe(false)
    expect(researchRunResultSchema.safeParse({ ...result, artifacts: ['out.json', 'out.json'] }).success).toBe(false)
    const { planRef: _plan, ...legacyShape } = result
    expect(() => parseRunLog(runId, text(description, { ...legacyShape, version: 2 }))).toThrow(/versions disagree/u)
  })
})
