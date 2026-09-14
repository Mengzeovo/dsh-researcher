import { createHash } from 'node:crypto'
import { parseDocument, stringify } from 'yaml'
import { z } from 'zod'
import { ResearcherError, invalidRecord } from './errors.ts'
import { RECORD_MAX_BYTES, assertUtf8Bound, parseResearchId, stableJsonLine } from './schema.ts'
import {
  planContentInputSchema,
  planDocumentSchema,
  planLedgerEntrySchema,
  planMetadataSchema,
  planNumberSchema,
  type PlanContentInput,
  type PlanDocument,
  type PlanLedgerEntry,
  type PlanRunEvidence,
} from './plan-schema.ts'
import type { ResearchId } from './types.ts'

export interface ParsedPlanLedger {
  readonly entries: readonly PlanLedgerEntry[]
  /** All validated original bytes, adding only a missing final line terminator. */
  readonly validText: string
}

function parseValue<T>(subject: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) invalidRecord(`${subject} does not match schema: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

export function formatPlanNumber(value: number): string {
  if (!planNumberSchema.safeParse(value).success) {
    throw new ResearcherError('plan identifiers and revisions must be positive safe integers', 'RESEARCH_PATH_INVALID')
  }
  return String(value).padStart(4, '0')
}

/** Only the one canonical spelling reserves a numeric final plan directory. */
export function parsePlanDirectoryName(name: string): number | undefined {
  if (!/^[0-9]+$/u.test(name)) return undefined
  const number = Number(name)
  if (!planNumberSchema.safeParse(number).success) return undefined
  return formatPlanNumber(number) === name ? number : undefined
}

export function planRoot(id: ResearchId): string {
  return `.research/goal/${parseResearchId(id)}/plan`
}

export function planDirectory(id: ResearchId, planId: number): string {
  return `${planRoot(id)}/${formatPlanNumber(planId)}`
}

export function planVersionFile(revision: number): string {
  return `v${formatPlanNumber(revision)}.md`
}

export function planVersionPath(id: ResearchId, planId: number, revision: number): string {
  return `${planDirectory(id, planId)}/${planVersionFile(revision)}`
}

export function planLedgerPath(id: ResearchId, planId: number): string {
  return `${planDirectory(id, planId)}/versions.jsonl`
}

export function hashPlanMarkdown(markdown: string): string {
  if (!markdown.isWellFormed()) invalidRecord('plan Markdown must be well-formed UTF-8 text')
  return createHash('sha256').update(markdown, 'utf8').digest('hex')
}

/** Parsing never normalizes the bytes hashed by the independent ledger. */
export function parsePlanDocument(
  markdown: string,
  expected?: { readonly planId: number; readonly revision: number },
): PlanDocument {
  assertUtf8Bound('plan Markdown', markdown, RECORD_MAX_BYTES)
  const sha256 = hashPlanMarkdown(markdown)
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown)
  if (match === null) invalidRecord('plan Markdown must begin with a complete YAML front matter block')
  const yaml = parseDocument(match[1]!, { version: '1.2', uniqueKeys: true, strict: true })
  if (yaml.errors.length > 0 || yaml.warnings.length > 0) {
    invalidRecord('plan front matter contains invalid YAML: ' + [...yaml.errors, ...yaml.warnings].map(error => error.message).join('; '))
  }
  let value: unknown
  try {
    value = yaml.toJS({ maxAliasCount: 100 })
  } catch (error) {
    invalidRecord('plan front matter cannot be decoded as YAML', { cause: error })
  }
  const metadata = parseValue('plan front matter', planMetadataSchema, value)
  if (expected !== undefined && (metadata.plan_id !== expected.planId || metadata.revision !== expected.revision)) {
    invalidRecord('plan front matter identity does not match its directory and revision filename')
  }
  // A single empty separator line belongs to the document wrapper, not the body.
  const body = markdown.slice(match[0].length).replace(/^\r?\n/u, '')
  return parseValue('plan document', planDocumentSchema, { metadata, body, markdown, sha256 })
}

/** Only the host passes the mechanical identity/time; caller content stays separate. */
export function renderPlanDocument(
  planId: number,
  revision: number,
  input: PlanContentInput,
  createdAt: string,
  evidence: readonly PlanRunEvidence[] = [],
  schemaVersion: 1 | 2 = 2,
): PlanDocument {
  const content = parseValue('plan input', planContentInputSchema, input)
  if (!evidenceMatchesInput(evidence, content) || (schemaVersion === 1 && evidence.length !== 0)) {
    invalidRecord('resolved experiment evidence differs from plan input')
  }
  const metadata = parseValue('plan front matter', planMetadataSchema, {
    schema_version: schemaVersion,
    plan_id: planId,
    revision,
    title: content.title,
    created_at: createdAt,
    delta: content.delta,
    ...(schemaVersion === 2 ? { based_on_runs: evidence } : {}),
  })
  const frontMatter = stringify(metadata, { lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' })
  return parsePlanDocument(`---\n${frontMatter}---\n\n${content.body}`, { planId, revision })
}

function evidenceMatchesInput(evidence: readonly PlanRunEvidence[], input: PlanContentInput): boolean {
  const requested = input.basedOnRuns ?? []
  return evidence.length === requested.length && evidence.every((item, index) => {
    const basis = requested[index]!
    return item.run_id === basis.runId && item.reason === basis.reason
  })
}

/** Exact replay retains the saved document format, timestamp, identity and evidence bytes. */
export function planContentMatches(document: PlanDocument, input: PlanContentInput): boolean {
  const evidence = document.metadata.schema_version === 2 ? document.metadata.based_on_runs : []
  if (!evidenceMatchesInput(evidence, input)) return false
  const rendered = renderPlanDocument(document.metadata.plan_id, document.metadata.revision, input, document.metadata.created_at, evidence, document.metadata.schema_version)
  return document.markdown === rendered.markdown && document.sha256 === rendered.sha256
}

export function planLedgerEntry(document: PlanDocument): PlanLedgerEntry {
  return parseValue('plan ledger entry', planLedgerEntrySchema, {
    schema_version: 1,
    plan_id: document.metadata.plan_id,
    revision: document.metadata.revision,
    file: planVersionFile(document.metadata.revision),
    sha256: document.sha256,
  })
}

/** Strict JSONL: no malformed/truncated tail is silently discarded. */
export function parsePlanLedger(planId: number, text: string): ParsedPlanLedger {
  formatPlanNumber(planId)
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  if (lines.length === 0 || text.length === 0) invalidRecord('versions.jsonl must contain at least one committed plan revision')
  const entries = lines.map((line, index) => {
    const subject = `versions.jsonl line ${index + 1}`
    if (line.length === 0) invalidRecord(`${subject} is an empty record`)
    assertUtf8Bound(subject, line, RECORD_MAX_BYTES)
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (error) {
      invalidRecord(`${subject} contains malformed JSON`, { cause: error })
    }
    const entry = parseValue(subject, planLedgerEntrySchema, value)
    if (entry.plan_id !== planId) invalidRecord(`${subject} belongs to a different plan`)
    if (entry.revision !== index + 1) {
      invalidRecord(`${subject} has revision ${entry.revision}; expected ${index + 1}`)
    }
    return entry
  })
  return { entries, validText: text.endsWith('\n') ? text : text + '\n' }
}

export function renderPlanLedger(entries: readonly PlanLedgerEntry[]): string {
  const first = entries[0]
  if (first === undefined) invalidRecord('versions.jsonl must contain at least one committed plan revision')
  const text = entries.map(entry => stableJsonLine(entry)).join('\n') + '\n'
  return parsePlanLedger(first.plan_id, text).validText
}

export function appendPlanLedgerText(parsed: ParsedPlanLedger, entry: PlanLedgerEntry): string {
  const first = parsed.entries[0]
  if (first === undefined) invalidRecord('cannot append to an empty committed plan ledger')
  if (entry.plan_id !== first.plan_id || entry.revision !== parsed.entries.length + 1) {
    invalidRecord('new plan ledger entry must belong to the same plan and be the exact next revision')
  }
  return parsePlanLedger(first.plan_id, parsed.validText + stableJsonLine(entry) + '\n').validText
}

/** Hash mismatches are corruption, never an invitation to update the ledger hash. */
export function verifyPlanLedgerDocument(document: PlanDocument, entry: PlanLedgerEntry): void {
  const valid = parseValue('plan ledger entry', planLedgerEntrySchema, entry)
  const actual = parsePlanDocument(document.markdown, { planId: valid.plan_id, revision: valid.revision })
  if (actual.sha256 !== valid.sha256 || document.sha256 !== actual.sha256) {
    invalidRecord(`plan revision ${valid.file} SHA-256 does not match its committed ledger entry`)
  }
}
