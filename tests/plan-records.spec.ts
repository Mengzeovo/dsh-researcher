import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecordStore, targetRoot } from '../src/record-store.ts'
import {
  appendPlanLedgerText,
  formatPlanNumber,
  hashPlanMarkdown,
  parsePlanDirectoryName,
  parsePlanDocument,
  parsePlanLedger,
  planContentMatches,
  planDirectory,
  planLedgerEntry,
  planLedgerPath,
  planRoot,
  planVersionFile,
  planVersionPath,
  renderPlanDocument,
  renderPlanLedger,
  verifyPlanLedgerDocument,
} from '../src/plan-records.ts'
import { planContentInputSchema, planMetadataSchema, planVersionRefSchema, type PlanContentInput } from '../src/plan-schema.ts'
import { RECORD_MAX_BYTES, parseResearchId } from '../src/schema.ts'
import { failNextWrite, makeWorkspace, removeWorkspace, testContext, testSession } from './helpers.ts'

const ID = parseResearchId('123e4567-e89b-42d3-a456-426614174001')
const AT = '2025-01-01T00:00:00.000Z'
const CONTENT: PlanContentInput = {
  title: 'Compare candidate and baseline',
  body: '# Method\nRun the two candidates with the same seed.\n\n## Evaluation\nCompare error, cost, and failure cases.\n',
  delta: ['Initial complete plan'],
}
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await removeWorkspace(root)
})

async function fixture() {
  const root = await makeWorkspace('researcher-plan-records'); roots.push(root)
  const ctx = testContext(root)
  const records = new RecordStore(ctx)
  const session = testSession(root)
  const policy = await records.ensureDirectories(session, ['.research', '.research/goal', targetRoot(ID)])
  return { root, ctx, records, session, policy }
}

async function publishInitial(f: Awaited<ReturnType<typeof fixture>>, planId = 1) {
  const document = renderPlanDocument(planId, 1, CONTENT, AT)
  const staging = `${planRoot(ID)}/.creating-${formatPlanNumber(planId)}-fixture`
  await f.records.ensureDirectories(f.session, [planRoot(ID), staging])
  await f.records.createText(f.session, `${staging}/v0001.md`, document.markdown, f.policy)
  await f.records.createText(f.session, `${staging}/versions.jsonl`, renderPlanLedger([planLedgerEntry(document)]), f.policy)
  await f.records.commitDirectory(f.session, staging, planDirectory(ID, planId))
  return document
}

describe('plan schemas and canonical documents', () => {
  it('keeps numeric public identities and one canonical padded filename spelling', () => {
    expect(planRoot(ID)).toBe(`${targetRoot(ID)}/plan`)
    expect(planDirectory(ID, 1)).toBe(`${targetRoot(ID)}/plan/0001`)
    expect(planVersionPath(ID, 1, 2)).toBe(`${targetRoot(ID)}/plan/0001/v0002.md`)
    expect(planVersionFile(10000)).toBe('v10000.md')
    expect(formatPlanNumber(Number.MAX_SAFE_INTEGER)).toBe(String(Number.MAX_SAFE_INTEGER))
    expect(parsePlanDirectoryName('0001')).toBe(1)
    expect(parsePlanDirectoryName('10000')).toBe(10000)
    for (const name of ['1', '00001', '0000', '-0001', '1e3', '.creating-0001', '9007199254740992']) {
      expect(parsePlanDirectoryName(name)).toBeUndefined()
    }
    for (const number of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => formatPlanNumber(number)).toThrow(/positive safe integers/u)
    }
    expect(() => planRoot('../escape' as typeof ID)).toThrow(/invalid research id/u)
  })

  it('renders all host metadata, real YAML strings, and the complete Unicode body deterministically', () => {
    const input = { title: '方案: "quoted"\nSecond line', body: '# Full plan\r\nKeep λ and 中文.\r\n', delta: ['Use seed: 7', 'Keep "quoted" details'] }
    const document = renderPlanDocument(10000, 2, input, AT)
    expect(document.metadata).toEqual({ schema_version: 2, plan_id: 10000, revision: 2, title: input.title, created_at: AT, delta: input.delta, based_on_runs: [] })
    expect(Object.keys(document.metadata)).toEqual(['schema_version', 'plan_id', 'revision', 'title', 'created_at', 'delta', 'based_on_runs'])
    expect(document.body).toBe(input.body)
    expect(parsePlanDocument(document.markdown, { planId: 10000, revision: 2 })).toEqual(document)
    expect(document.sha256).toBe(createHash('sha256').update(Buffer.from(document.markdown, 'utf8')).digest('hex'))
    expect(renderPlanDocument(10000, 2, input, AT)).toEqual(document)
  })

  it.each(['y', '# CRLF\r\nKeep the original line endings.\r\n', '\nLeading separator belongs to the body\n\n', 'One carriage return\rAnother line'])('preserves exact caller body bytes, including missing final newline (%j)', body => {
    const input = { ...CONTENT, body }
    const document = renderPlanDocument(1, 1, input, AT)
    expect(document.body).toBe(body)
    expect(document.markdown.endsWith(body)).toBe(true)
    expect(parsePlanDocument(document.markdown).body).toBe(body)
    expect(planContentMatches(document, input)).toBe(true)
    expect(planContentMatches(document, { ...input, body: body + '\n' })).toBe(false)
  })

  it('has strict shared reference/content schemas and no model-supplied mechanical fields', () => {
    const document = renderPlanDocument(1, 1, CONTENT, AT)
    expect(planVersionRefSchema.parse({ planId: 1, revision: 1, sha256: document.sha256 })).toEqual({ planId: 1, revision: 1, sha256: document.sha256 })
    for (const extra of [{ created_at: AT }, { plan_id: 1 }, { revision: 2 }, { sha256: document.sha256 }]) {
      expect(planContentInputSchema.safeParse({ ...CONTENT, ...extra }).success).toBe(false)
    }
    expect(planMetadataSchema.safeParse({ ...document.metadata, selected: true }).success).toBe(false)
    expect(planVersionRefSchema.safeParse({ planId: '0001', revision: 1, sha256: document.sha256 }).success).toBe(false)
    expect(planVersionRefSchema.safeParse({ planId: 1, revision: 1, sha256: document.sha256.toUpperCase() }).success).toBe(false)
  })

  it.each([
    ['schema_version: 2', 'schema_version: 3'],
    ['plan_id: 1', 'plan_id: "1"'],
    ['revision: 1', 'revision: 1.5'],
    ['created_at: "2025-01-01T00:00:00.000Z"', 'created_at: "not-a-time"'],
    ['title:', 'unexpected: true\ntitle:'],
    ['title:', 'plan_id: 1\ntitle:'],
  ])('rejects invalid or duplicate YAML fields (%s)', (before, after) => {
    const document = renderPlanDocument(1, 1, CONTENT, AT)
    expect(document.markdown).toContain(before)
    expect(() => parsePlanDocument(document.markdown.replace(before, after))).toThrow()
  })

  it('requires complete front matter, matching identity, nonblank fields, and a nonempty delta array', () => {
    const document = renderPlanDocument(1, 1, CONTENT, AT)
    expect(() => parsePlanDocument('# Missing front matter')).toThrow(/front matter/u)
    expect(() => parsePlanDocument('---\nplan_id: 1')).toThrow(/complete YAML/u)
    expect(() => parsePlanDocument(document.markdown, { planId: 2, revision: 1 })).toThrow(/identity/u)
    expect(() => parsePlanDocument(document.markdown, { planId: 1, revision: 2 })).toThrow(/identity/u)
    for (const patch of [{ title: '  ' }, { body: '\n ' }, { delta: [] }, { delta: [''] }]) {
      expect(() => renderPlanDocument(1, 1, { ...CONTENT, ...patch }, AT)).toThrow()
    }
    expect(() => parsePlanDocument(document.markdown.slice(0, document.markdown.indexOf('# Method')))).toThrow(/document/u)
  })

  it('bounds the entire UTF-8 snapshot and rejects lossy Unicode input before rendering', () => {
    expect(() => renderPlanDocument(1, 1, { ...CONTENT, body: '界'.repeat(RECORD_MAX_BYTES / 2) }, AT)).toThrow(/UTF-8 bytes/u)
    expect(() => parsePlanDocument('x'.repeat(RECORD_MAX_BYTES + 1))).toThrow(/UTF-8 bytes/u)
    expect(() => renderPlanDocument(1, 1, { ...CONTENT, body: '\ud800' }, AT)).toThrow(/Unicode/u)
    expect(() => hashPlanMarkdown('invalid \ud800')).toThrow(/well-formed/u)
  })

  it('matches only full canonical replay with the saved host identity and timestamp', () => {
    const document = renderPlanDocument(1, 2, CONTENT, AT)
    expect(planContentMatches(document, CONTENT)).toBe(true)
    expect(planContentMatches(document, { ...CONTENT, body: CONTENT.body.trimEnd() })).toBe(false)
    for (const changed of [{ ...CONTENT, title: 'Other title' }, { ...CONTENT, body: CONTENT.body + '\nChanged' }, { ...CONTENT, delta: ['Other change'] }]) {
      expect(planContentMatches(document, changed)).toBe(false)
    }
    const reformatted = parsePlanDocument(document.markdown.replace('plan_id: 1', 'plan_id:  1'))
    expect(reformatted.metadata).toEqual(document.metadata)
    expect(planContentMatches(reformatted, CONTENT)).toBe(false)
    expect(planContentMatches({ ...document, sha256: '0'.repeat(64) }, CONTENT)).toBe(false)
  })
})

describe('strict independent plan ledgers', () => {
  it('preserves validated prefix bytes and appends exactly the next revision', () => {
    const first = planLedgerEntry(renderPlanDocument(1, 1, CONTENT, AT))
    const second = planLedgerEntry(renderPlanDocument(1, 2, { ...CONTENT, delta: ['Second snapshot'] }, AT))
    const original = JSON.stringify(first).replace('{', '{ ') + '\n'
    const parsed = parsePlanLedger(1, original)
    expect(parsed.entries).toEqual([first])
    expect(parsed.validText).toBe(original)
    const appended = appendPlanLedgerText(parsed, second)
    expect(appended).toBe(original + JSON.stringify(second) + '\n')
    expect(parsePlanLedger(1, appended).entries).toEqual([first, second])
    expect(() => appendPlanLedgerText(parsed, { ...second, revision: 3, file: 'v0003.md' })).toThrow(/exact next/u)
  })

  it('accepts a complete final record without newline but rejects every malformed tail', () => {
    const first = planLedgerEntry(renderPlanDocument(1, 1, CONTENT, AT))
    const json = JSON.stringify(first)
    expect(parsePlanLedger(1, json).validText).toBe(json + '\n')
    for (const tail of ['{"schema_version":', '{"schema_version":}', 'not-json', '']) {
      expect(() => parsePlanLedger(1, json + '\n' + tail + (tail === '' ? '\n' : ''))).toThrow()
    }
    expect(() => parsePlanLedger(1, '')).toThrow(/at least one/u)
  })

  it('rejects duplicate/gapped/out-of-order records, wrong ownership, unsafe filenames and invalid digests', () => {
    const first = planLedgerEntry(renderPlanDocument(1, 1, CONTENT, AT))
    expect(() => renderPlanLedger([first, first])).toThrow(/expected 2/u)
    expect(() => renderPlanLedger([{ ...first, revision: 2, file: 'v0002.md' }])).toThrow(/expected 1/u)
    for (const patch of [{ plan_id: 2 }, { file: '../v0001.md' }, { file: 'v1.md' }, { sha256: 'bad' }, { unknown: true }]) {
      expect(() => parsePlanLedger(1, JSON.stringify({ ...first, ...patch }))).toThrow()
    }
    expect(() => renderPlanLedger([])).toThrow(/at least one/u)
  })

  it('bounds each row without imposing a total ledger ceiling', () => {
    const first = planLedgerEntry(renderPlanDocument(1, 1, CONTENT, AT))
    const row = JSON.stringify(first)
    expect(() => parsePlanLedger(1, row + ' '.repeat(RECORD_MAX_BYTES))).toThrow(/UTF-8 bytes/u)
    const entries = Array.from({ length: 18 }, (_, index) => {
      const line = JSON.stringify({ ...first, revision: index + 1, file: planVersionFile(index + 1) })
      return line + ' '.repeat(RECORD_MAX_BYTES - line.length)
    })
    const text = entries.join('\n') + '\n'
    expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024)
    expect(parsePlanLedger(1, text).entries).toHaveLength(18)
  })

  it('verifies exact recorded bytes rather than rehashing changed committed content', () => {
    const document = renderPlanDocument(1, 1, CONTENT, AT)
    const entry = planLedgerEntry(document)
    expect(() => verifyPlanLedgerDocument(document, entry)).not.toThrow()
    for (const text of [document.markdown + '\n', document.markdown.replace('plan_id: 1', 'plan_id:  1')]) {
      expect(() => verifyPlanLedgerDocument(parsePlanDocument(text), entry)).toThrow(/SHA-256/u)
    }
    expect(() => verifyPlanLedgerDocument(document, { ...entry, plan_id: 2 })).toThrow(/identity/u)
    expect(() => verifyPlanLedgerDocument(document, { ...entry, sha256: '0'.repeat(64) })).toThrow(/SHA-256/u)
  })
})

describe('RecordStore plan persistence boundary', () => {
  it('treats a missing optional plan root as empty without creating directories', async () => {
    const f = await fixture()
    expect(await f.records.listPlanEntries(f.session, ID)).toEqual([])
    expect(await readdir(path.join(f.root, targetRoot(ID)))).toEqual([])
    await expect(f.records.readPlanLedger(f.session, ID, 1)).rejects.toMatchObject({ code: 'RESEARCH_NOT_FOUND' })
  })

  it('exposes both initial records together through existing staging-directory publication', async () => {
    const f = await fixture()
    const document = await publishInitial(f)
    expect((await f.records.listPlanEntries(f.session, ID)).map(entry => entry.name)).toEqual(['0001'])
    expect((await f.records.listPlanFiles(f.session, ID, 1)).map(entry => entry.name).sort()).toEqual(['v0001.md', 'versions.jsonl'])
    const ledger = await f.records.readPlanLedger(f.session, ID, 1)
    const observed = await f.records.readPlanDocument(f.session, ID, 1, 1)
    expect(observed.value).toEqual(document)
    expect(observed.text).toBe(document.markdown)
    expect(observed.relativePath).toBe(planVersionPath(ID, 1, 1))
    expect(observed.version).toBeDefined()
    expect(observed.target).toBeDefined()
    expect(ledger.value.entries).toEqual([planLedgerEntry(document)])
    verifyPlanLedgerDocument(observed.value, ledger.value.entries[0]!)
  })

  it('does not expose half-created plans when the initial ledger write fails', async () => {
    const f = await fixture()
    const staging = `${planRoot(ID)}/.creating-0001-failure`
    await f.records.ensureDirectories(f.session, [planRoot(ID), staging])
    const document = renderPlanDocument(1, 1, CONTENT, AT)
    await f.records.createText(f.session, `${staging}/v0001.md`, document.markdown, f.policy)
    await failNextWrite(f.ctx, `${staging}/versions.jsonl`, 'initial ledger failed', 'createIfAbsent')
    await expect(f.records.createText(f.session, `${staging}/versions.jsonl`, renderPlanLedger([planLedgerEntry(document)]), f.policy)).rejects.toThrow('initial ledger failed')
    expect((await f.records.listPlanEntries(f.session, ID)).map(entry => entry.name)).toEqual(['.creating-0001-failure'])
    await f.records.discardStaging(f.session, staging)
    expect(await f.records.listPlanEntries(f.session, ID)).toEqual([])
  })

  it('reads unregistered next snapshots without promoting them or altering their bytes', async () => {
    const f = await fixture()
    await publishInitial(f)
    const before = await f.records.readPlanLedger(f.session, ID, 1)
    expect(await f.records.findPlanDocument(f.session, ID, 1, 2)).toBeUndefined()
    const next = renderPlanDocument(1, 2, { ...CONTENT, delta: ['Changed evaluation'] }, AT)
    await f.records.createText(f.session, planVersionPath(ID, 1, 2), next.markdown, f.policy)
    const pending = await f.records.findPlanDocument(f.session, ID, 1, 2)
    expect(pending?.value).toEqual(next)
    expect((await f.records.readPlanLedger(f.session, ID, 1)).text).toBe(before.text)
    expect((await f.records.readPlanLedger(f.session, ID, 1)).value.entries).toHaveLength(1)
    expect(planContentMatches(pending!.value, { ...CONTENT, delta: ['Changed evaluation'] })).toBe(true)
    expect(await readFile(path.join(f.root, planVersionPath(ID, 1, 2)), 'utf8')).toBe(next.markdown)
  })

  it('uses original ledger observations for CAS and never retries over newer bytes', async () => {
    const f = await fixture()
    await publishInitial(f)
    const observed = await f.records.readPlanLedger(f.session, ID, 1)
    const next = renderPlanDocument(1, 2, { ...CONTENT, delta: ['Second revision'] }, AT)
    const intended = appendPlanLedgerText(observed.value, planLedgerEntry(next))
    const newer = observed.text.replace('{', '{  ')
    await writeFile(path.join(f.root, planLedgerPath(ID, 1)), newer)
    const write = vi.spyOn(f.ctx.fs, 'writeText')
    const read = vi.spyOn(f.ctx.fs, 'streamText')
    await expect(f.records.replaceText(f.session, observed, planLedgerPath(ID, 1), intended)).rejects.toMatchObject({ code: 'RESEARCH_STALE_WRITE' })
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0]?.[2]).toEqual({ kind: 'replaceIfVersion', version: observed.version })
    expect(read).not.toHaveBeenCalled()
    expect(await readFile(path.join(f.root, planLedgerPath(ID, 1)), 'utf8')).toBe(newer)
  })

  it('keeps already written revisions immutable through create-if-absent', async () => {
    const f = await fixture()
    const first = await publishInitial(f)
    await expect(f.records.createText(f.session, planVersionPath(ID, 1, 1), 'replacement', f.policy)).rejects.toMatchObject({ code: 'RESEARCH_STALE_WRITE' })
    expect((await f.records.readPlanDocument(f.session, ID, 1, 1)).text).toBe(first.markdown)
  })

  it.each(['plan', 'directory', 'markdown', 'ledger'] as const)('refuses symlinked %s authority components even within the workspace', async component => {
    const f = await fixture()
    const document = await publishInitial(f)
    const relative = component === 'plan' ? planRoot(ID) : component === 'directory' ? planDirectory(ID, 1) : component === 'markdown' ? planVersionPath(ID, 1, 1) : planLedgerPath(ID, 1)
    const target = path.join(f.root, 'actual-' + component)
    if (component === 'plan' || component === 'directory') {
      await mkdir(target)
      await rm(path.join(f.root, relative), { recursive: true })
    } else {
      await writeFile(target, component === 'markdown' ? document.markdown : renderPlanLedger([planLedgerEntry(document)]))
      await rm(path.join(f.root, relative))
    }
    await symlink(target, path.join(f.root, relative))
    const read = component === 'plan' ? f.records.listPlanEntries(f.session, ID) : component === 'ledger' ? f.records.readPlanLedger(f.session, ID, 1) : f.records.readPlanDocument(f.session, ID, 1, 1)
    await expect(read).rejects.toMatchObject({ code: 'RESEARCH_PATH_INVALID' })
  })

  it('rejects oversized bytes before content loading and rejects lossy UTF-8 decoding', async () => {
    const f = await fixture()
    const document = await publishInitial(f)
    const relative = planVersionPath(ID, 1, 1)
    await writeFile(path.join(f.root, relative), 'x'.repeat(RECORD_MAX_BYTES + 1))
    const read = vi.spyOn(f.ctx.fs, 'readBytes')
    await expect(f.records.readPlanDocument(f.session, ID, 1, 1)).rejects.toMatchObject({ code: 'RESEARCH_OVERSIZED' })
    expect(read).not.toHaveBeenCalled()
    await writeFile(path.join(f.root, relative), Buffer.concat([Buffer.from(document.markdown), Buffer.from([255])]))
    await expect(f.records.readPlanDocument(f.session, ID, 1, 1)).rejects.toThrow(/not valid UTF-8/u)
    await writeFile(path.join(f.root, relative), '\ufeff' + document.markdown)
    await expect(f.records.readPlanDocument(f.session, ID, 1, 1)).rejects.toThrow(/front matter/u)
  })

  it('reports missing/changed registered snapshots rather than repairing the ledger', async () => {
    const f = await fixture()
    const original = await publishInitial(f)
    const ledger = await f.records.readPlanLedger(f.session, ID, 1)
    await writeFile(path.join(f.root, planVersionPath(ID, 1, 1)), original.markdown + '\n')
    const changed = await f.records.readPlanDocument(f.session, ID, 1, 1)
    expect(() => verifyPlanLedgerDocument(changed.value, ledger.value.entries[0]!)).toThrow(/SHA-256/u)
    await rm(path.join(f.root, planVersionPath(ID, 1, 1)))
    await expect(f.records.readPlanDocument(f.session, ID, 1, 1)).rejects.toMatchObject({ code: 'RESEARCH_NOT_FOUND' })
    expect((await f.records.readPlanLedger(f.session, ID, 1)).text).toBe(ledger.text)
  })

  it('allows read-only inspection but refuses publication before any file changes', async () => {
    const f = await fixture()
    const original = await publishInitial(f)
    const observed = await f.records.readPlanLedger(f.session, ID, 1)
    vi.spyOn(f.ctx.sandboxPolicy, 'resolve').mockReturnValue({ mode: 'read-only', workspaceRoot: f.root })
    const write = vi.spyOn(f.ctx.fs, 'writeText')
    expect((await f.records.readPlanDocument(f.session, ID, 1, 1)).text).toBe(original.markdown)
    await expect(f.records.replaceText(f.session, observed, planLedgerPath(ID, 1), observed.text)).rejects.toThrow(/read-only/u)
    await expect(f.records.ensureDirectories(f.session, [planDirectory(ID, 2)])).rejects.toThrow(/read-only/u)
    expect(write).not.toHaveBeenCalled()
    expect((await f.records.listPlanEntries(f.session, ID)).map(entry => entry.name)).toEqual(['0001'])
  })
})
