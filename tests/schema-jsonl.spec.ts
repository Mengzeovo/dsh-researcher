import { describe, expect, it } from 'vitest'
import { buildResearchContext, markerResearchId, researchGoalObjective } from '../src/context.ts'
import { ResearcherError } from '../src/errors.ts'
import { appendStateText, parseRunLog, parseStateLog, renderClosedRun, renderOpenRun } from '../src/jsonl.ts'
import {
  decodeSessionId,
  encodeSessionId,
  normalizeProjectRelativePath,
  parseGoalMarkdown,
  parseResearchId,
  parseRunId,
  renderGoalMarkdown,
  stableJsonLine,
  truncateLabel,
} from '../src/schema.ts'
import type { ResearchBinding, ResearchRunDescription, ResearchRunResult, ResearchState, ResearchTargetSnapshot } from '../src/types.ts'

const RESEARCH_ID = parseResearchId('123e4567-e89b-42d3-a456-426614174000')
const RUN_ID = parseRunId('123e4567-e89b-42d3-b456-426614174001')
const AT = '2026-03-01T00:00:00.000Z'
const BINDING: ResearchBinding = {
  version: 1,
  researchId: RESEARCH_ID,
  sessionId: 'session/one',
  loadedAt: AT,
}

function state(revision: number, summary = `revision ${revision}`): ResearchState {
  return {
    version: 1,
    revision,
    at: AT,
    sessionId: 'session/one',
    status: 'active',
    summary,
  }
}

describe('goal and path schemas', () => {
  it('round-trips the strict goal document', () => {
    const markdown = renderGoalMarkdown('Measure the new method.\n\nKeep scope narrow.', ['latency <= 10 ms', 'no regression'], 'baseline v1')
    const parsed = parseGoalMarkdown(markdown)
    expect(parsed.goal).toContain('Measure the new method.')
    expect(parsed.metrics).toBe('- latency <= 10 ms\n- no regression')
    expect(parsed.baseline).toBe('baseline v1')
    expect(parsed.description).toBe('Measure the new method.')
  })

  it('rejects duplicate or reordered mandatory headings', () => {
    expect(() => parseGoalMarkdown('# Goal\na\n## Baseline\nb\n## Metrics\nc\n')).toThrow(ResearcherError)
    expect(() => parseGoalMarkdown('# Goal\na\n# Goal\nb\n## Metrics\nc\n## Baseline\nd\n')).toThrow(/exactly one # Goal/u)
  })

  it('normalizes no unsafe project paths', () => {
    expect(normalizeProjectRelativePath('results/run.json')).toBe('results/run.json')
    for (const invalid of ['/tmp/x', '../x', 'a/../x', 'a//x', 'C:\\tmp\\x', ' x']) {
      expect(() => normalizeProjectRelativePath(invalid)).toThrow(ResearcherError)
    }
  })

  it('round-trips arbitrary DSH session ids through canonical base64url', () => {
    const id = 'root/子会话:session.with symbols'
    expect(decodeSessionId(encodeSessionId(id))).toBe(id)
    expect(() => decodeSessionId('YWJj=')).toThrow(ResearcherError)
  })

  it('bounds popup labels without changing short descriptions', () => {
    expect(truncateLabel('short')).toBe('short')
    const truncated = truncateLabel('x'.repeat(500))
    expect(truncated).toHaveLength(120)
    expect(truncated.endsWith('…')).toBe(true)
  })
})

describe('append-only JSONL', () => {
  it('accepts a legal final record without a newline', () => {
    const text = `${stableJsonLine(state(1))}\n${stableJsonLine(state(2))}`
    const parsed = parseStateLog(text)
    expect(parsed.states).toHaveLength(2)
    expect(parsed.warning).toBeUndefined()
    expect(parsed.validText.endsWith('\n')).toBe(true)
  })

  it('ignores only an interrupted final fragment', () => {
    const text = `${stableJsonLine(state(1))}\n{"version":1`
    const parsed = parseStateLog(text)
    expect(parsed.states).toHaveLength(1)
    expect(parsed.warning).toMatch(/incomplete trailing JSON fragment/u)

    expect(() => parseStateLog(`${stableJsonLine(state(1))}\n{"version":}`)).toThrow(/malformed JSON at line 2/u)
    expect(() => parseStateLog(`${stableJsonLine(state(1))}\nnot-json`)).toThrow(/malformed JSON at line 2/u)
  })

  it('rejects empty middle records, revision gaps, and reopening after complete', () => {
    expect(() => parseStateLog(`${stableJsonLine(state(1))}\n\n${stableJsonLine(state(2))}\n`)).toThrow(/empty record/u)
    expect(() => parseStateLog(`${stableJsonLine(state(1))}\n${stableJsonLine(state(3))}\n`)).toThrow(/expected 2/u)
    const complete = { ...state(1), status: 'complete' as const }
    expect(() => parseStateLog(`${stableJsonLine(complete)}\n${stableJsonLine(state(2))}\n`))
      .toThrow(/follows terminal complete revision 1/u)
  })

  it('appends one exact next revision', () => {
    const parsed = parseStateLog(`${stableJsonLine(state(1))}\n`)
    expect(parseStateLog(appendStateText(parsed, state(2))).states.at(-1)?.revision).toBe(2)
    expect(() => appendStateText(parsed, state(3))).toThrow(/does not follow/u)
  })

  it('renders immutable one- or two-record run files', () => {
    const description: ResearchRunDescription = {
      version: 1,
      type: 'description',
      createdAt: AT,
      sessionId: 'session/one',
      purpose: 'baseline',
      parameters: { seed: 1 },
    }
    const result: ResearchRunResult = {
      version: 1,
      type: 'result',
      finishedAt: AT,
      status: 'completed',
      result: 'negative result',
      metrics: { loss: 3 },
      decision: 'keep as evidence',
      artifacts: [],
      transition: { ...state(2), lastRunId: RUN_ID },
    }
    expect(parseRunLog(RUN_ID, renderOpenRun(description)).result).toBeUndefined()
    expect(parseRunLog(RUN_ID, renderClosedRun(description, result)).result).toEqual(result)
    expect(() => parseRunLog(RUN_ID, `${renderClosedRun(description, result)}{}\n`)).toThrow(/at most one result/u)
  })
})

describe('bounded context and Goal marker', () => {
  it('keeps mandatory identity/goal/state and truncates optional material deterministically', () => {
    const goal = parseGoalMarkdown(renderGoalMarkdown('A bounded goal', ['metric'], 'baseline'))
    const target: ResearchTargetSnapshot = {
      id: RESEARCH_ID,
      root: `.research/goal/${RESEARCH_ID}`,
      goalPath: `.research/goal/${RESEARCH_ID}/goal.md`,
      goal,
      state: state(1),
      glossary: { version: 1, terms: { huge: 'x'.repeat(40_000) }, files: {} },
      warnings: Array.from({ length: 1_000 }, (_, index) => `missing-${index}-${'w'.repeat(80)}`),
    }
    const context = buildResearchContext(target, BINDING)
    expect(context.text.length).toBeLessThanOrEqual(32 * 1024)
    expect(context.sections.map(section => section.name).slice(0, 4)).toEqual([
      'researcher:binding',
      'researcher:identity',
      'researcher:goal',
      'researcher:state',
    ])
    expect(context.text).toContain('truncated this optional section')
    const objective = researchGoalObjective(target)
    expect(markerResearchId(objective)).toBe(RESEARCH_ID)
    expect(markerResearchId('ordinary goal')).toBeUndefined()
  })
})
