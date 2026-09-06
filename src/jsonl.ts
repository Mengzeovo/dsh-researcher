import { z } from 'zod'
import type { ResearchRun, ResearchRunDescription, ResearchRunResult, ResearchState, RunId } from './types.ts'
import {
  RECORD_MAX_BYTES,
  assertUtf8Bound,
  researchRunDescriptionSchema,
  researchRunResultSchema,
  researchStateSchema,
  stableJsonLine,
} from './schema.ts'
import { invalidRecord } from './errors.ts'

export interface ParsedStateLog {
  readonly states: readonly ResearchState[]
  readonly validText: string
  readonly warning?: string
}

interface ParsedLine {
  readonly line: string
  readonly value: unknown
}

function isIncompleteJsonFragment(text: string, error: SyntaxError): boolean {
  if (text.trim().length === 0) return false
  if (/Unexpected end of JSON input|Unterminated string/u.test(error.message)) return true
  const position = /at position (\d+)/u.exec(error.message)?.[1]
  return position !== undefined && Number(position) === text.length
    && /Expected ',' or '[}\]]'|No number after minus sign|Exponent part is missing a number/u.test(error.message)
}

function splitJsonl(subject: string, text: string, allowIncompleteTail: boolean): {
  readonly lines: readonly ParsedLine[]
  readonly warning?: string
} {
  const raw = text.split('\n')
  const endedWithNewline = text.endsWith('\n')
  if (endedWithNewline) raw.pop()
  let warning: string | undefined
  if (!endedWithNewline && allowIncompleteTail && raw.length > 0) {
    const tail = raw.at(-1) as string
    try {
      JSON.parse(tail)
    } catch (error) {
      if (error instanceof SyntaxError && isIncompleteJsonFragment(tail, error)) {
        raw.pop()
        warning = `${subject} ended with an incomplete trailing JSON fragment; it was ignored`
      } else if (!(error instanceof SyntaxError)) {
        throw error
      }
    }
  }
  const lines: ParsedLine[] = []
  raw.forEach((line, index) => {
    if (line.length === 0) invalidRecord(`${subject} contains an empty record at line ${index + 1}`)
    assertUtf8Bound(`${subject} line ${index + 1}`, line, RECORD_MAX_BYTES)
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (error) {
      invalidRecord(`${subject} contains malformed JSON at line ${index + 1}`, { cause: error })
    }
    lines.push({ line, value })
  })
  return warning === undefined ? { lines } : { lines, warning }
}

export function parseStateLog(text: string): ParsedStateLog {
  const parsed = splitJsonl('state.jsonl', text, true)
  if (parsed.lines.length === 0) invalidRecord('state.jsonl must contain at least one valid state record')
  let terminalRevision: number | undefined
  const states = parsed.lines.map((entry, index) => {
    const state = researchStateSchema.safeParse(entry.value)
    if (!state.success) invalidRecord(`state.jsonl line ${index + 1} does not match schema: ${z.prettifyError(state.error)}`)
    const expected = index + 1
    if (state.data.revision !== expected) {
      invalidRecord(`state.jsonl line ${index + 1} has revision ${state.data.revision}; expected ${expected}`)
    }
    if (terminalRevision !== undefined) {
      invalidRecord(`state.jsonl line ${index + 1} follows terminal complete revision ${terminalRevision}`)
    }
    if (state.data.status === 'complete') terminalRevision = state.data.revision
    return state.data
  })
  const validText = `${parsed.lines.map(entry => entry.line).join('\n')}\n`
  return parsed.warning === undefined
    ? { states, validText }
    : { states, validText, warning: parsed.warning }
}

export function appendStateText(parsed: ParsedStateLog, state: ResearchState): string {
  const expected = parsed.states.length + 1
  if (state.revision !== expected) invalidRecord(`new state revision ${state.revision} does not follow ${expected - 1}`)
  return `${parsed.validText}${stableJsonLine(state)}\n`
}

export function parseRunLog(runId: RunId, text: string): ResearchRun {
  const parsed = splitJsonl(`runs/${runId}.jsonl`, text, false)
  if (parsed.lines.length < 1 || parsed.lines.length > 2) {
    invalidRecord(`runs/${runId}.jsonl must contain one description and at most one result`)
  }
  const description = researchRunDescriptionSchema.safeParse(parsed.lines[0]?.value)
  if (!description.success) invalidRecord(`runs/${runId}.jsonl description is invalid: ${z.prettifyError(description.error)}`)
  if (description.data.version === 2) {
    const cp = description.data.checkpoint
    if (!cp.inputRef.endsWith('/runs/' + runId + '/input')
      || cp.outputRef !== cp.inputRef.slice(0, -'input'.length) + 'output') {
      invalidRecord('checkpoint refs do not identify their run')
    }
    const width = cp.objectFormat === 'sha1' ? 40 : 64
    if ([cp.inputCommit, cp.inputTree, cp.baseHead].some(oid => oid.length !== width)) invalidRecord('checkpoint object format mismatch')
  }
  const resultLine = parsed.lines[1]
  if (resultLine === undefined) return { id: runId, description: description.data }
  const result = researchRunResultSchema.safeParse(resultLine.value)
  if (!result.success) invalidRecord(`runs/${runId}.jsonl result is invalid: ${z.prettifyError(result.error)}`)
  const desc = description.data
  const closed = result.data
  if (desc.version !== closed.version) invalidRecord(`runs/${runId}.jsonl record versions disagree`)
  if (desc.version === 2 && closed.version === 2) {
    const before = desc.checkpoint
    const after = closed.checkpoint
    const width = after.objectFormat === 'sha1' ? 40 : 64
    if ([after.inputCommit, after.outputCommit, after.inputTree, after.outputTree].some(oid => oid.length !== width)) invalidRecord('checkpoint object format mismatch')
    if (closed.transition.revision !== desc.baseStateRevision + 1
      || closed.transition.lastRunId !== runId
      || before.inputCommit !== after.inputCommit || before.inputTree !== after.inputTree
      || before.inputRef !== after.inputRef || before.outputRef !== after.outputRef
      || before.objectFormat !== after.objectFormat
      || after.codeChanged !== (after.inputTree !== after.outputTree)) {
      invalidRecord(`runs/${runId}.jsonl checkpoint identity or transition disagrees with its description`)
    }
  }
  return { id: runId, description: desc, result: closed }
}

export function renderOpenRun(description: ResearchRunDescription): string {
  return `${stableJsonLine(description)}\n`
}

export function renderClosedRun(description: ResearchRunDescription, result: ResearchRunResult): string {
  return `${stableJsonLine(description)}\n${stableJsonLine(result)}\n`
}
