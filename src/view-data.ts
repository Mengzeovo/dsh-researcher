/** Reads immutable graph inputs without an Agent, checkpoint capture, or authority writes. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { FsError } from '@deepseek-ai/dsh-fs'
import { ResearcherError } from './errors.ts'
import { parsePlanDirectoryName, planDirectory, planLedgerPath, planVersionFile, planVersionPath, verifyPlanLedgerDocument } from './plan-records.ts'
import { runPath, type RecordStore, type VersionedText } from './record-store.ts'
import { parseRunId } from './schema.ts'
import { UUID_PATTERN } from './wire.ts'
import type { ResearchId } from './types.ts'
import type { ResearchReadContext, ResearchViewConfig, ResearchViewData, ResearchViewDiagnostic, ResearchViewPlanRecord, ResearchViewRunRecord } from './view-types.ts'

/** Caller holds the same per-target mutex used by research mutations. */
export async function readResearchViewData(records: RecordStore, context: ResearchReadContext, id: ResearchId, config: ResearchViewConfig, signal?: AbortSignal): Promise<ResearchViewData> {
  signal?.throwIfAborted()
  let bytes = 0
  let count = 0
  const version = createHash('sha256')
  const observe = (file: VersionedText): void => {
    signal?.throwIfAborted()
    bytes += Buffer.byteLength(file.text, 'utf8')
    if (bytes > config.maxDataBytes) throw new ResearcherError('research view input exceeds its configured byte limit', 'RESEARCH_OVERSIZED')
    version.update(JSON.stringify([file.relativePath, file.text]))
  }
  const reserve = (amount = 1): void => {
    count += amount
    if (count > config.maxRecords) throw new ResearcherError('research view input exceeds its configured record limit', 'RESEARCH_OVERSIZED')
  }
  const diagnostics: ResearchViewDiagnostic[] = []
  const diagnose = (error: unknown, file: string, planId?: number): void => {
    signal?.throwIfAborted()
    if (bytes > config.maxDataBytes || count > config.maxRecords) throw error
    if (!(error instanceof ResearcherError) && !(error instanceof FsError)) throw error
    const diagnostic: ResearchViewDiagnostic = { code: error.code, message: error.message, path: file, ...(planId === undefined ? {} : { planId }) }
    diagnostics.push(diagnostic)
    version.update(JSON.stringify(diagnostic))
  }
  const planEntries = await records.listPlanEntries(context, id, signal)
  const goal = await records.readGoal(context, id, signal); observe(goal)
  const stateLog = await records.readStateLog(context, id, signal, config.maxDataBytes - bytes); observe(stateLog)
  const state = stateLog.value.states.at(-1)!
  const plans: ResearchViewPlanRecord[] = []
  const runs: ResearchViewRunRecord[] = []
  const planDirectories = planEntries.filter(entry => entry.type === 'directory').map(entry => parsePlanDirectoryName(entry.name)).filter((value): value is number => value !== undefined).sort((a, b) => a - b)
  reserve(planEntries.length)
  for (const entry of [...planEntries].sort((a, b) => a.name.localeCompare(b.name))) {
    const planId = parsePlanDirectoryName(entry.name)
    if (planId === undefined) {
      if (!entry.name.startsWith('.')) {
        const diagnostic = { code: 'PLAN_UNREGISTERED_ENTRY', message: 'This entry is not a canonical plan directory.', path: '.research/goal/' + id + '/plan/' + entry.name }
        diagnostics.push(diagnostic); version.update(JSON.stringify(diagnostic))
      }
      continue
    }
    let ledger: Awaited<ReturnType<RecordStore['readPlanLedger']>>
    try { ledger = await records.readPlanLedger(context, id, planId, signal, config.maxDataBytes - bytes) }
    catch (error) { diagnose(error, planLedgerPath(id, planId), planId); continue }
    observe(ledger); reserve(ledger.value.entries.length)
    const names = new Set(ledger.value.entries.map(row => planVersionFile(row.revision)))
    for (const row of ledger.value.entries) {
      try {
        const file = await records.readPlanDocument(context, id, planId, row.revision, signal)
        observe(file)
        verifyPlanLedgerDocument(file.value, row)
        plans.push({ document: file.value, path: file.relativePath })
      } catch (error) { diagnose(error, planVersionPath(id, planId, row.revision), planId) }
    }
    try {
      const files = await records.listPlanFiles(context, id, planId, signal)
      reserve(files.length)
      for (const file of files) {
        if (!/^v[0-9]+\.md$/u.test(file.name) || names.has(file.name)) continue
        const diagnostic = { code: 'PLAN_UNPUBLISHED_VERSION', message: 'This version is not registered in the immutable plan ledger.', path: planDirectory(id, planId) + '/' + file.name, planId }
        diagnostics.push(diagnostic); version.update(JSON.stringify(diagnostic))
      }
    } catch (error) { diagnose(error, planDirectory(id, planId), planId) }
  }
  await records.assertRealDirectory(context, '.research/goal/' + id + '/runs', signal)
  const runEntries = await records.listRunEntries(context, id, signal, true)
  reserve(runEntries.length)
  for (const entry of [...runEntries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith('.jsonl') || !UUID_PATTERN.test(entry.name.slice(0, -6))) continue
    const runId = parseRunId(entry.name.slice(0, -6))
    try {
      const file = await records.readRun(context, id, runId, signal)
      observe(file)
      const transition = file.value.result?.transition
      const committed = file.value.result !== undefined && transition !== undefined && isDeepStrictEqual(stateLog.value.states.find(candidate => candidate.revision === transition.revision), transition)
      runs.push({ run: file.value, path: file.relativePath, sha256: createHash('sha256').update(file.text).digest('hex'), committed })
    } catch (error) { diagnose(error, runPath(id, runId)) }
  }
  signal?.throwIfAborted()
  version.update(JSON.stringify(diagnostics))
  return { researchId: id, goal: goal.value, state, planDirectories, plans, runs, diagnostics, recordVersion: version.digest('hex') }
}
