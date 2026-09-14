import { createHash, randomUUID } from 'node:crypto';
import { GitCheckpointProvider } from "./checkpoint.js";
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { buildResearchContext } from "./context.js";
import { notebookDirectories } from "./notebook.js";
import { RecordStore, targetRoot, statePath, glossaryPath, runPath, sessionPath } from "./record-store.js";
import { planContentInputSchema, planVersionRefSchema } from "./plan-schema.js";
import { appendPlanLedgerText, formatPlanNumber, parsePlanDirectoryName, planContentMatches, planDirectory, planLedgerEntry, planLedgerPath, planRoot, planVersionFile, planVersionPath, renderPlanDocument, renderPlanLedger, verifyPlanLedgerDocument, } from "./plan-records.js";
import { isCheckpointRunDescription, isCheckpointRunResult, samePlanVersionRef } from "./types.js";
import { ResearcherError, invalidRecord } from "./errors.js";
import { appendStateText, parseRunLog, renderClosedRun, renderOpenRun } from "./jsonl.js";
import { RECORD_MAX_BYTES, SESSION_INDEX_MAX_BYTES, encodeSessionId, nowIso, normalizeProjectRelativePath, parseGoalMarkdown, parseResearchId, parseRunId, renderGoalMarkdown, researchGlossarySchema, reproductionSchema, researchRunDescriptionSchema, researchRunResultSchema, researchPreparedRunResultSchema, researchSessionIndexSchema, researchStateSchema, stableJsonLine, truncateLabel, } from "./schema.js";
class FifoMutex {
    tail = Promise.resolve();
    async run(operation) {
        const previous = this.tail;
        let release;
        this.tail = new Promise(resolve => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        }
        finally {
            release();
        }
    }
}
function contextBinding(session, id, loadedAt) {
    return {
        version: 1,
        researchId: id,
        sessionId: String(session.id),
        loadedAt,
    };
}
function assertContextFits(session, target, loadedAt) {
    buildResearchContext(target, contextBinding(session, target.id, loadedAt));
}
function cloneJsonRecord(value) {
    const parsed = z.record(z.string(), z.json()).safeParse(value);
    if (!parsed.success)
        invalidRecord(`JSON map is not lossless JSON: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
}
/** Canonical caller payload: key order cannot change an idempotent finish identity. */
function canonicalJson(value) {
    if (Array.isArray(value))
        return '[' + value.map(canonicalJson).join(',') + ']';
    if (value !== null && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
}
function stateFieldsMatch(left, right, selectedPlanRef) {
    return left.status === right.status
        && left.summary === right.summary
        && left.direction === right.direction
        && left.next === right.next
        && left.lastRunId === right.lastRunId
        && samePlanVersionRef(left.selectedPlanRef, selectedPlanRef);
}
import { readResearchViewData } from "./view-data.js";
/** Research operation coordinator. Owns complete-operation locks and publication policy, not file I/O or Goal policy. */
export class ResearchStore {
    checkpoints;
    mutexes = new Map();
    logger;
    records;
    constructor(ctx, checkpoints = new GitCheckpointProvider(ctx)) {
        this.checkpoints = checkpoints;
        this.logger = ctx.logger('researcher.store');
        this.records = new RecordStore(ctx);
    }
    async mutex(session, id) {
        // Session cwd aliases must not create independent locks for the same target.
        const key = `${await this.records.canonicalWorkspace(session)}\u0000${id}`;
        let mutex = this.mutexes.get(key);
        if (mutex === undefined) {
            mutex = new FifoMutex();
            this.mutexes.set(key, mutex);
        }
        return mutex;
    }
    /** Resolve the filesystem identity used by both writer locks and read-only views. */
    async canonicalWorkspace(context) {
        return await this.records.canonicalWorkspace(context);
    }
    /** Read graph records under the writer's target lock without creating a Session or Agent. */
    async readViewData(context, id, config, signal) {
        return await (await this.mutex(context, id)).run(() => readResearchViewData(this.records, context, id, config, signal));
    }
    async createTarget(session, request, signal) {
        const id = parseResearchId(randomUUID());
        return await (await this.mutex(session, id)).run(async () => {
            const stagingName = `.creating-${id}`;
            const stagingRoot = `.research/goal/${stagingName}`;
            const finalRoot = targetRoot(id);
            const at = nowIso();
            const markdown = renderGoalMarkdown(request.goal, request.metrics, request.baseline);
            const parsedGoal = parseGoalMarkdown(markdown);
            const state = researchStateSchema.parse({
                version: 2,
                revision: 1,
                at,
                sessionId: String(session.id),
                status: 'active',
                summary: parsedGoal.description,
                ...(request.direction === undefined ? {} : { direction: request.direction }),
                ...(request.next === undefined ? {} : { next: request.next }),
            });
            const glossary = researchGlossarySchema.parse({ version: 1, terms: {}, files: {} });
            const index = researchSessionIndexSchema.parse({
                version: 1,
                sessionId: String(session.id),
                loadedAt: at,
                runIds: [],
            });
            const initialTarget = {
                id,
                root: finalRoot,
                goalPath: `${finalRoot}/goal.md`,
                goal: parsedGoal,
                state,
                glossary,
                warnings: [],
            };
            assertContextFits(session, initialTarget, at);
            const directories = [
                '.research',
                '.research/goal',
                '.research/evo',
                stagingRoot,
                `${stagingRoot}/session`,
                `${stagingRoot}/runs`,
                ...Object.values(notebookDirectories(stagingRoot)),
            ];
            const policy = await this.records.ensureDirectories(session, directories);
            try {
                await this.records.createText(session, `${stagingRoot}/goal.md`, markdown, policy, signal);
                await this.records.createText(session, `${stagingRoot}/state.jsonl`, `${stableJsonLine(state)}\n`, policy, signal);
                await this.records.createText(session, `${stagingRoot}/glossary.json`, `${JSON.stringify(glossary, null, 2)}\n`, policy, signal);
                await this.records.createText(session, `${stagingRoot}/session/${encodeSessionId(String(session.id))}.json`, `${JSON.stringify(index, null, 2)}\n`, policy, signal);
                await this.records.commitDirectory(session, stagingRoot, finalRoot);
            }
            catch (error) {
                await this.records.discardStaging(session, stagingRoot).catch(cleanupError => {
                    this.logger.warn('failed to discard research staging directory %s: %s', stagingRoot, String(cleanupError));
                });
                throw error;
            }
            return await this.readTarget(session, id, signal);
        });
    }
    async readTarget(session, idInput, signal) {
        const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput;
        const root = targetRoot(id);
        await this.records.assertRealDirectory(session, '.research', signal);
        await this.records.assertRealDirectory(session, '.research/goal', signal);
        await this.records.assertRealDirectory(session, root, signal);
        await this.records.assertRealDirectory(session, `${root}/session`, signal);
        await this.records.assertRealDirectory(session, `${root}/runs`, signal);
        const goal = (await this.records.readGoal(session, id, signal)).value;
        const stateFile = await this.records.readStateLog(session, id, signal);
        const stateLog = stateFile.value;
        const state = stateLog.states.at(-1);
        if (state === undefined)
            invalidRecord(`${root}/state.jsonl has no current state`);
        const glossary = (await this.records.readGlossary(session, id, signal)).value;
        const warnings = [];
        if (stateLog.warning !== undefined)
            warnings.push(stateLog.warning);
        await this.validateGlossaryFiles(session, glossary, warnings, signal);
        let latestRun;
        if (state.lastRunId !== undefined) {
            latestRun = await this.readRun(session, id, state.lastRunId, signal);
            if (latestRun.result === undefined) {
                invalidRecord(`${statePath(id)} lastRunId ${state.lastRunId} refers to an open run`);
            }
        }
        let selectedPlan;
        if (state.selectedPlanRef !== undefined) {
            try {
                const selected = await this.verifyPlanRef(session, id, state.selectedPlanRef, signal);
                selectedPlan = { ref: state.selectedPlanRef, title: selected.plan.metadata.title, path: selected.path };
                warnings.push(...selected.warnings);
            }
            catch (error) {
                if (signal?.aborted)
                    throw error;
                warnings.push('Selected plan integrity error: ' + (error instanceof Error ? error.message : String(error)));
            }
        }
        const recovery = await this.readRecovery(session, id, state.revision, signal);
        const checked = new Set(state.selectedPlanRef === undefined ? [] : [JSON.stringify(state.selectedPlanRef)]);
        const runRefs = [
            ...(latestRun?.description.version === 3 ? [{ runId: latestRun.id, ref: latestRun.description.planRef }] : []),
            ...(recovery?.planRef === undefined ? [] : [{ runId: recovery.runId, ref: recovery.planRef }]),
        ];
        for (const item of runRefs) {
            const key = JSON.stringify(item.ref);
            if (checked.has(key))
                continue;
            checked.add(key);
            try {
                await this.verifyPlanRef(session, id, item.ref, signal);
            }
            catch (error) {
                if (signal?.aborted)
                    throw error;
                warnings.push('Run ' + item.runId + ' plan integrity error: ' + (error instanceof Error ? error.message : String(error)));
            }
        }
        return {
            id,
            root,
            goalPath: targetRoot(id) + '/goal.md',
            goal,
            state,
            glossary,
            ...(selectedPlan === undefined ? {} : { selectedPlan }),
            ...(latestRun === undefined ? {} : { latestRun }),
            recovery,
            warnings,
        };
    }
    async listTargets(session, signal) {
        const entries = await this.records.listTargetEntries(session, signal);
        const targets = [];
        const invalid = [];
        for (const entry of entries) {
            if (entry.name.startsWith('.creating-'))
                continue;
            let id;
            try {
                id = parseResearchId(entry.name);
            }
            catch {
                continue;
            }
            if (entry.type !== 'directory') {
                invalid.push({ id, code: 'RESEARCH_INVALID_RECORD', detail: 'target path is not a directory' });
                continue;
            }
            try {
                const target = await this.readTarget(session, id, signal);
                targets.push({
                    id,
                    description: truncateLabel(target.goal.description),
                    status: target.state.status,
                    updatedAt: target.state.at,
                    warningCount: target.warnings.length,
                });
            }
            catch (error) {
                invalid.push({
                    id,
                    code: error instanceof ResearcherError ? error.code : 'RESEARCH_INVALID_RECORD',
                    detail: this.shortError(error),
                });
            }
        }
        targets.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
        invalid.sort((left, right) => left.id.localeCompare(right.id));
        return { targets, invalid };
    }
    async createPlan(session, idInput, request, signal) {
        const id = parseResearchId(idInput);
        const input = planContentInputSchema.parse(request);
        if ((input.basedOnRuns?.length ?? 0) !== 0)
            throw new ResearcherError('initial plans cannot cite experiment evidence', 'RESEARCH_PLAN_EVIDENCE');
        return await (await this.mutex(session, id)).run(async () => {
            const target = await this.readTarget(session, id, signal);
            if (target.state.status === 'complete')
                throw new ResearcherError('completed targets cannot create plans', 'RESEARCH_TARGET_COMPLETE');
            this.records.writePolicy(session);
            const entries = await this.records.listPlanEntries(session, id, signal);
            let maximum = 0;
            for (const entry of entries) {
                const number = parsePlanDirectoryName(entry.name);
                if (number === undefined)
                    continue;
                if (entry.type !== 'directory')
                    throw new ResearcherError('numeric plan path is not a directory: ' + entry.name, 'RESEARCH_PATH_INVALID');
                maximum = Math.max(maximum, number);
            }
            const planId = maximum + 1;
            formatPlanNumber(planId);
            const document = renderPlanDocument(planId, 1, input, nowIso());
            const root = planRoot(id);
            const finalRoot = planDirectory(id, planId);
            const staging = root + '/.creating-' + formatPlanNumber(planId) + '-' + randomUUID();
            const policy = await this.records.ensureDirectories(session, [root, staging]);
            let published = false;
            try {
                await this.records.createText(session, staging + '/' + planVersionFile(1), document.markdown, policy, signal);
                await this.records.createText(session, staging + '/versions.jsonl', renderPlanLedger([planLedgerEntry(document)]), policy, signal);
                await this.records.commitDirectory(session, staging, finalRoot);
                published = true;
                return await this.readPlanLocked(session, id, { planId, revision: 1 }, signal);
            }
            catch (error) {
                if (!published)
                    await this.records.discardStaging(session, staging).catch(cleanup => this.logger.warn('failed to discard plan staging %s: %s', staging, String(cleanup)));
                throw new ResearcherError('plan ' + planId + (published ? ' was published; inspect ' : ' creation failed; inspect ') + finalRoot + ' before creating again: ' + String(error), error instanceof ResearcherError ? error.code : 'RESEARCH_INVALID_RECORD', { cause: error });
            }
        });
    }
    async getPlan(session, idInput, request, signal) {
        const id = parseResearchId(idInput);
        return await (await this.mutex(session, id)).run(async () => await this.readPlanLocked(session, id, request, signal));
    }
    async readPlanLocked(session, id, request, signal) {
        formatPlanNumber(request.planId);
        const ledger = (await this.records.readPlanLedger(session, id, request.planId, signal)).value;
        const latest = ledger.entries.at(-1);
        if (latest === undefined)
            invalidRecord('plan ' + request.planId + ' has no committed versions');
        const revision = request.revision ?? latest.revision;
        formatPlanNumber(revision);
        const entry = ledger.entries.find(item => item.revision === revision);
        if (entry === undefined)
            throw new ResearcherError('plan ' + request.planId + ' revision ' + revision + ' is not committed', 'RESEARCH_NOT_FOUND');
        const document = (await this.records.readPlanDocument(session, id, request.planId, revision, signal)).value;
        verifyPlanLedgerDocument(document, entry);
        if (document.metadata.schema_version === 2 && document.metadata.based_on_runs.length !== 0) {
            const recorded = document.metadata.based_on_runs;
            const actual = await this.resolvePlanEvidence(session, id, request.planId, revision, recorded.map(item => ({ runId: item.run_id, reason: item.reason })), signal);
            if (!isDeepStrictEqual(actual, recorded))
                throw new ResearcherError('sealed experiment evidence digest differs from the plan version', 'RESEARCH_PLAN_INTEGRITY');
        }
        const registered = new Set(ledger.entries.map(item => item.file));
        const warnings = [];
        for (const file of await this.records.listPlanFiles(session, id, request.planId, signal)) {
            if (/^v.*\.md$/u.test(file.name) && !registered.has(file.name))
                warnings.push('Uncommitted plan file (never selected as latest): ' + planDirectory(id, request.planId) + '/' + file.name);
        }
        return { researchId: id, plan: document, path: planVersionPath(id, request.planId, revision), latestRevision: latest.revision, warnings };
    }
    async listPlans(session, idInput, request = {}, signal) {
        const id = parseResearchId(idInput);
        const afterId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(request.afterId ?? 0);
        const limit = z.number().int().min(1).max(100).parse(request.limit ?? 50);
        return await (await this.mutex(session, id)).run(async () => {
            await this.records.readStateLog(session, id, signal);
            const entries = (await this.records.listPlanEntries(session, id, signal))
                .map(entry => ({ entry, planId: parsePlanDirectoryName(entry.name) }))
                .filter((item) => item.planId !== undefined && item.planId > afterId)
                .sort((left, right) => left.planId - right.planId);
            const page = entries.slice(0, limit);
            const plans = [];
            const invalid = [];
            for (const { entry, planId } of page) {
                try {
                    if (entry.type !== 'directory')
                        throw new ResearcherError('plan path is not a directory', 'RESEARCH_PATH_INVALID');
                    const value = await this.readPlanLocked(session, id, { planId }, signal);
                    plans.push({ planId, latestRevision: value.latestRevision, title: truncateLabel(value.plan.metadata.title), createdAt: value.plan.metadata.created_at, sha256: value.plan.sha256, path: value.path });
                }
                catch (error) {
                    invalid.push({ planId, code: error instanceof ResearcherError ? error.code : 'RESEARCH_INVALID_RECORD', detail: this.shortError(error) });
                }
            }
            return { researchId: id, plans, invalid, ...(entries.length > limit ? { nextAfterId: page.at(-1).planId } : {}) };
        });
    }
    async updatePlan(session, idInput, request, signal) {
        const id = parseResearchId(idInput);
        formatPlanNumber(request.planId);
        formatPlanNumber(request.expectedRevision);
        const input = planContentInputSchema.parse({ title: request.title, body: request.body, delta: request.delta, basedOnRuns: request.basedOnRuns });
        return await (await this.mutex(session, id)).run(async () => {
            const target = await this.readTarget(session, id, signal);
            const ledgerFile = await this.records.readPlanLedger(session, id, request.planId, signal);
            const ledger = ledgerFile.value;
            const latest = ledger.entries.at(-1);
            if (latest === undefined)
                invalidRecord('plan has no committed versions');
            for (const entry of ledger.entries) {
                verifyPlanLedgerDocument((await this.records.readPlanDocument(session, id, request.planId, entry.revision, signal)).value, entry);
            }
            if (latest.revision === request.expectedRevision + 1) {
                const committed = await this.readPlanLocked(session, id, { planId: request.planId, revision: latest.revision }, signal);
                if (planContentMatches(committed.plan, input))
                    return committed;
            }
            if (latest.revision !== request.expectedRevision)
                throw new ResearcherError('plan latest revision is ' + latest.revision + ', expected ' + request.expectedRevision, 'RESEARCH_STALE_WRITE');
            if (target.state.status === 'complete')
                throw new ResearcherError('completed targets cannot revise plans', 'RESEARCH_TARGET_COMPLETE');
            const policy = this.records.writePolicy(session);
            const revision = request.expectedRevision + 1;
            const nextFile = planVersionFile(revision);
            const registered = new Set(ledger.entries.map(entry => entry.file));
            for (const entry of await this.records.listPlanFiles(session, id, request.planId, signal)) {
                if (/^v.*\.md$/u.test(entry.name) && !registered.has(entry.name) && (entry.name !== nextFile || entry.type !== 'file')) {
                    throw new ResearcherError('conflicting uncommitted plan file: ' + entry.name + '; preserve it and inspect before retrying', 'RESEARCH_PLAN_CONFLICT');
                }
            }
            const pending = await this.records.findPlanDocument(session, id, request.planId, revision, signal);
            const evidence = await this.resolvePlanEvidence(session, id, request.planId, revision, input.basedOnRuns ?? [], signal);
            const document = pending?.value ?? renderPlanDocument(request.planId, revision, input, nowIso(), evidence);
            if (pending !== undefined && !planContentMatches(document, input))
                throw new ResearcherError('uncommitted next plan version differs from this update; retry the original payload', 'RESEARCH_PLAN_CONFLICT');
            if (document.metadata.schema_version === 2 && !isDeepStrictEqual(document.metadata.based_on_runs, evidence))
                throw new ResearcherError('uncommitted plan evidence no longer matches its sealed experiments', 'RESEARCH_PLAN_INTEGRITY');
            if (pending === undefined)
                await this.records.createText(session, planVersionPath(id, request.planId, revision), document.markdown, policy, signal);
            await this.records.replaceText(session, ledgerFile, planLedgerPath(id, request.planId), appendPlanLedgerText(ledger, planLedgerEntry(document)), signal);
            return await this.readPlanLocked(session, id, { planId: request.planId, revision }, signal);
        });
    }
    /** Call under the target mutex; evidence only points to committed, earlier versions. */
    async resolvePlanEvidence(session, id, planId, revision, basis, signal) {
        if (basis.length === 0)
            return [];
        const states = (await this.records.readStateLog(session, id, signal)).value.states;
        const ledger = (await this.records.readPlanLedger(session, id, planId, signal)).value;
        const evidence = [];
        for (const item of basis) {
            const file = await this.records.readRun(session, id, parseRunId(item.runId), signal);
            const run = file.value;
            if (run.description.version !== 3 || run.description.planRef.planId !== planId || run.description.planRef.revision >= revision) {
                throw new ResearcherError('experiment evidence must use an earlier revision of the same plan', 'RESEARCH_PLAN_EVIDENCE');
            }
            if (run.result === undefined || !states.some(state => isDeepStrictEqual(state, run.result.transition))) {
                throw new ResearcherError('experiment evidence must be sealed with its state transition committed', 'RESEARCH_PLAN_EVIDENCE');
            }
            const ref = run.description.planRef;
            const entry = ledger.entries.find(value => value.revision === ref.revision);
            if (entry === undefined || entry.sha256 !== ref.sha256)
                throw new ResearcherError('experiment evidence has an unverified plan reference', 'RESEARCH_PLAN_INTEGRITY');
            const plan = (await this.records.readPlanDocument(session, id, planId, ref.revision, signal)).value;
            verifyPlanLedgerDocument(plan, entry);
            evidence.push({ run_id: run.id, reason: item.reason, sha256: createHash('sha256').update(file.text, 'utf8').digest('hex') });
        }
        return evidence;
    }
    async selectPlan(session, idInput, request, signal) {
        const id = parseResearchId(idInput);
        formatPlanNumber(request.expectedStateRevision);
        return await (await this.mutex(session, id)).run(async () => {
            const target = await this.readTarget(session, id, signal);
            const stateFile = await this.records.readStateLog(session, id, signal);
            const current = stateFile.value.states.at(-1);
            if (!isDeepStrictEqual(current, target.state) || current.revision !== request.expectedStateRevision)
                throw new ResearcherError('research state changed before plan selection', 'RESEARCH_STALE_WRITE');
            if (current.status === 'complete')
                throw new ResearcherError('completed targets cannot select plans', 'RESEARCH_TARGET_COMPLETE');
            if (target.recovery !== undefined)
                throw new ResearcherError('finish run ' + target.recovery.runId + ' before changing the selected plan', 'RESEARCH_RUN_OPEN');
            const selected = await this.readPlanLocked(session, id, request, signal);
            const ref = planVersionRefSchema.parse({ planId: request.planId, revision: request.revision, sha256: selected.plan.sha256 });
            if (samePlanVersionRef(current.selectedPlanRef, ref))
                return { researchId: id, state: current, path: statePath(id) };
            const state = researchStateSchema.parse({ ...current, version: 2, revision: current.revision + 1, at: nowIso(), sessionId: String(session.id), selectedPlanRef: ref });
            assertContextFits(session, { ...target, state, selectedPlan: { ref, title: selected.plan.metadata.title, path: selected.path } }, state.at);
            await this.records.replaceText(session, stateFile, statePath(id), appendStateText(stateFile.value, state), signal);
            return { researchId: id, state, path: statePath(id) };
        });
    }
    async verifyPlanRef(session, id, ref, signal) {
        const value = await this.readPlanLocked(session, id, ref, signal);
        if (value.plan.sha256 !== ref.sha256)
            throw new ResearcherError('pinned plan digest differs from its committed version: ' + value.path, 'RESEARCH_PLAN_INTEGRITY');
        return value;
    }
    async appendState(session, idInput, request, signal) {
        const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput;
        return await (await this.mutex(session, id)).run(async () => await this.appendStateLocked(session, id, request, signal));
    }
    async appendStateLocked(session, id, request, signal) {
        const target = await this.readTarget(session, id, signal);
        const stateFile = await this.records.readStateLog(session, id, signal);
        const log = stateFile.value;
        const current = log.states.at(-1);
        if (current === undefined)
            invalidRecord(`${statePath(id)} has no current state`);
        if (current.revision !== target.state.revision) {
            throw new ResearcherError(`${statePath(id)} changed while preparing the update`, 'RESEARCH_STALE_WRITE');
        }
        if (current.status === 'complete') {
            throw new ResearcherError(`research target ${id} is complete and cannot be reopened in v1`, 'RESEARCH_TARGET_COMPLETE');
        }
        const pendingRun = await this.findPendingTransition(session, id, current.revision, signal);
        if (pendingRun !== undefined) {
            throw new ResearcherError(`closed run ${pendingRun} must finish publishing its prepared state before another state update`, 'RESEARCH_STALE_WRITE');
        }
        const checkpointRun = await this.findOpenRun(session, id, signal);
        if (checkpointRun !== undefined && isCheckpointRunDescription((await this.readRun(session, id, checkpointRun, signal)).description)) {
            throw new ResearcherError(`research run ${checkpointRun} freezes state until finish publishes its checkpoint`, 'RESEARCH_RUN_OPEN');
        }
        if (request.status === 'complete') {
            const openRun = await this.findOpenRun(session, id, signal);
            if (openRun !== undefined) {
                throw new ResearcherError(`research run ${openRun} is still open; finish it before completing the target`, 'RESEARCH_RUN_OPEN');
            }
        }
        let latestRun;
        if (request.lastRunId !== undefined) {
            latestRun = await this.readRun(session, id, request.lastRunId, signal);
            if (latestRun.result === undefined)
                invalidRecord(`lastRunId ${request.lastRunId} refers to an open run`);
        }
        const state = researchStateSchema.parse({
            version: 2,
            revision: current.revision + 1,
            at: nowIso(),
            sessionId: String(session.id),
            status: request.status,
            summary: request.summary,
            ...(request.direction === undefined ? {} : { direction: request.direction }),
            ...(request.next === undefined ? {} : { next: request.next }),
            ...(request.lastRunId === undefined ? {} : { lastRunId: request.lastRunId }),
            ...(current.selectedPlanRef === undefined ? {} : { selectedPlanRef: current.selectedPlanRef }),
        });
        const prospective = {
            id: target.id,
            root: target.root,
            goalPath: target.goalPath,
            goal: target.goal,
            state,
            glossary: target.glossary,
            ...(latestRun === undefined ? {} : { latestRun }),
            warnings: target.warnings,
        };
        assertContextFits(session, prospective, state.at);
        await this.records.replaceText(session, stateFile, statePath(id), appendStateText(log, state), signal);
        return { researchId: id, state, path: statePath(id) };
    }
    async resumeState(session, idInput, signal) {
        const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput;
        return await (await this.mutex(session, id)).run(async () => {
            const target = await this.readTarget(session, id, signal);
            if (target.recovery !== undefined || (target.state.status !== 'paused' && target.state.status !== 'blocked'))
                return target;
            await this.appendStateLocked(session, id, {
                status: 'active',
                summary: target.state.summary,
                ...(target.state.direction === undefined ? {} : { direction: target.state.direction }),
                ...(target.state.next === undefined ? {} : { next: target.state.next }),
                ...(target.state.lastRunId === undefined ? {} : { lastRunId: target.state.lastRunId }),
            }, signal);
            return await this.readTarget(session, id, signal);
        });
    }
    async startRun(session, idInput, request, signal) {
        const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput;
        return await (await this.mutex(session, id)).run(async () => {
            const target = await this.readTarget(session, id, signal);
            if (target.state.status === 'complete') {
                throw new ResearcherError(`research target ${id} is complete`, 'RESEARCH_TARGET_COMPLETE');
            }
            if (target.state.status !== 'active') {
                throw new ResearcherError(`research target ${id} is ${target.state.status}; load context with /research-load ${id}; resume state only with explicit authorization (use /research-start for continuous work) before starting a run`, 'RESEARCH_TARGET_INACTIVE');
            }
            const pendingRun = await this.findPendingTransition(session, id, target.state.revision, signal);
            if (pendingRun !== undefined) {
                throw new ResearcherError(`closed run ${pendingRun} must finish publishing its prepared state before another run starts`, 'RESEARCH_STALE_WRITE');
            }
            const openRun = await this.findOpenRun(session, id, signal);
            if (openRun !== undefined) {
                throw new ResearcherError(`research run ${openRun} is still open; finish it before starting another execution`, 'RESEARCH_RUN_OPEN');
            }
            const requestedPlan = z.object({ planId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().safeParse(request.plan);
            const selected = target.state.selectedPlanRef;
            if (!requestedPlan.success || selected === undefined)
                throw new ResearcherError('save and explicitly select a plan before every new run; provide its exact plan_id and revision', 'RESEARCH_PLAN_REQUIRED');
            if (requestedPlan.data.planId !== selected.planId || requestedPlan.data.revision !== selected.revision)
                throw new ResearcherError('run plan does not match the selected research plan; select the intended version first', 'RESEARCH_PLAN_CONFLICT');
            await this.verifyPlanRef(session, id, selected, signal);
            const policy = this.records.writePolicy(session);
            const reproduction = reproductionSchema.parse(request.reproduction);
            const runId = parseRunId(randomUUID());
            const base = researchRunDescriptionSchema.parse({
                version: 1,
                type: 'description',
                createdAt: nowIso(),
                sessionId: String(session.id),
                purpose: request.purpose,
                parameters: cloneJsonRecord(request.parameters),
            });
            // Reject oversized caller material before creating any Git objects/refs.
            stableJsonLine({ ...base, reproduction, planRef: selected });
            const checkpoint = await this.checkpoints.start(session, id, runId, base.createdAt, reproduction, signal);
            try {
                const description = researchRunDescriptionSchema.parse({
                    ...base, version: 3, baseStateRevision: target.state.revision, checkpoint, planRef: selected,
                });
                await this.records.createText(session, runPath(id, runId), renderOpenRun(description), policy, signal);
            }
            catch (error) {
                throw new ResearcherError('input checkpoint was retained at ' + checkpoint.inputRef + ' but run publication failed; no execution was started', 'RESEARCH_CHECKPOINT_INVALID', { cause: error });
            }
            await this.ensureSessionIndex(session, id, signal).catch(error => {
                this.logger.warn('run %s was created but its rebuildable session index was not updated: %s', runId, String(error));
            });
            return { researchId: id, runId, path: runPath(id, runId), checkpoint, planRef: selected };
        });
    }
    async finishRun(session, idInput, request, signal) {
        const id = parseResearchId(idInput);
        return await (await this.mutex(session, id)).run(async () => {
            const runFile = await this.records.readRun(session, id, request.runId, signal);
            const run = runFile.value;
            this.records.writePolicy(session);
            const metrics = cloneJsonRecord(request.metrics);
            // Keep the legacy request-key shape unchanged. Selection is Host-owned, never a finish argument.
            const requestedState = {
                status: request.researchStatus, summary: request.summary,
                ...(request.direction === undefined ? {} : { direction: request.direction }),
                ...(request.next === undefined ? {} : { next: request.next }),
                lastRunId: request.runId,
            };
            let closedRun;
            if (run.result !== undefined) {
                const artifacts = this.normalizeArtifactPaths(request.artifacts);
                const selection = run.description.version === 3 ? run.description.planRef : run.result.transition.selectedPlanRef;
                if (run.result.status !== request.status || run.result.result !== request.result
                    || !isDeepStrictEqual(run.result.metrics, metrics) || run.result.decision !== request.decision
                    || !isDeepStrictEqual(run.result.artifacts, artifacts)
                    || !stateFieldsMatch(run.result.transition, requestedState, selection)) {
                    throw new ResearcherError('run ' + request.runId + ' is already closed with a different immutable result or transition', 'RESEARCH_RUN_CLOSED');
                }
                closedRun = run;
            }
            else {
                const currentTarget = await this.readTarget(session, id, signal);
                if (currentTarget.state.status === 'complete')
                    throw new ResearcherError('research target ' + id + ' is complete', 'RESEARCH_TARGET_COMPLETE');
                const openRun = await this.findOpenRun(session, id, signal);
                if (openRun !== request.runId)
                    throw new ResearcherError('run ' + request.runId + ' is not the target open run (' + (openRun ?? 'none') + ')', 'RESEARCH_RUN_OPEN');
                if (isCheckpointRunDescription(run.description) && currentTarget.state.revision !== run.description.baseStateRevision) {
                    throw new ResearcherError('state changed after the run input checkpoint; refusing a stale finish', 'RESEARCH_STALE_WRITE');
                }
                const planRef = run.description.version === 3 ? run.description.planRef : undefined;
                const selection = planRef ?? currentTarget.state.selectedPlanRef;
                if (planRef !== undefined && !samePlanVersionRef(currentTarget.state.selectedPlanRef, planRef))
                    throw new ResearcherError('selected plan changed after the run started', 'RESEARCH_STALE_WRITE');
                const artifacts = isCheckpointRunDescription(run.description)
                    ? this.normalizeArtifactPaths(request.artifacts)
                    : await this.validateArtifacts(session, request.artifacts, signal);
                const transition = researchStateSchema.parse({
                    version: 2, revision: currentTarget.state.revision + 1, at: nowIso(), sessionId: String(session.id),
                    ...requestedState, ...(selection === undefined ? {} : { selectedPlanRef: selection }),
                });
                const prepared = researchPreparedRunResultSchema.parse({
                    version: planRef === undefined ? 1 : 3, type: 'result', finishedAt: nowIso(),
                    status: request.status, result: request.result, metrics, decision: request.decision, artifacts, transition,
                    ...(planRef === undefined ? {} : { planRef }),
                });
                // No partial checkpoint result is fabricated for this mandatory-state preflight.
                assertContextFits(session, { ...currentTarget, recovery: undefined, state: transition }, transition.at);
                stableJsonLine(prepared);
                let result;
                if (isCheckpointRunDescription(run.description)) {
                    const description = run.description;
                    const requestKey = createHash('sha256').update(canonicalJson({
                        status: request.status, result: request.result, metrics: { ...metrics },
                        decision: request.decision, artifacts,
                        transition: { ...requestedState, ...(planRef === undefined ? {} : { selectedPlanRef: { ...planRef } }) },
                        ...(planRef === undefined ? {} : { planRef: { ...planRef } }),
                    })).digest('hex');
                    const frozenResult = (sealed) => {
                        if (sealed.prepared.version !== (description.version === 3 ? 3 : 1))
                            throw new ResearcherError('checkpoint journal prepared version disagrees with the run', 'RESEARCH_CHECKPOINT_INVALID');
                        return researchRunResultSchema.parse({ ...sealed.prepared, version: description.version, checkpoint: sealed.checkpoint });
                    };
                    const validate = (sealed) => {
                        const frozen = frozenResult(sealed);
                        if (frozen.status !== request.status || frozen.result !== request.result
                            || !isDeepStrictEqual(frozen.metrics, metrics) || frozen.decision !== request.decision
                            || !isDeepStrictEqual(frozen.artifacts, artifacts) || !stateFieldsMatch(frozen.transition, requestedState, selection)
                            || frozen.transition.revision !== currentTarget.state.revision + 1) {
                            throw new ResearcherError('checkpoint journal disagrees with the exact finish payload or state', 'RESEARCH_CHECKPOINT_INVALID');
                        }
                        parseRunLog(request.runId, renderClosedRun(description, frozen));
                        assertContextFits(session, { ...currentTarget, recovery: undefined, state: frozen.transition, latestRun: { ...run, result: frozen } }, frozen.transition.at);
                    };
                    const sealed = await this.checkpoints.finish(session, description.checkpoint, requestKey, JSON.parse(stableJsonLine(prepared)), signal, validate, planRef === undefined ? undefined : async () => { await this.verifyPlanRef(session, id, planRef, signal); });
                    validate(sealed);
                    result = frozenResult(sealed);
                }
                else {
                    result = researchRunResultSchema.parse(prepared);
                }
                closedRun = { ...run, result };
                await this.records.replaceText(session, runFile, runPath(id, request.runId), renderClosedRun(run.description, result), signal);
            }
            const state = await this.appendPreparedRunState(session, id, closedRun, signal);
            await this.ensureSessionIndex(session, id, signal).catch(error => {
                this.logger.warn('run %s finished but its rebuildable session index was not updated: %s', request.runId, String(error));
            });
            return {
                researchId: id, runId: request.runId, runStatus: closedRun.result.status,
                ...(isCheckpointRunResult(closedRun.result) ? { checkpoint: closedRun.result.checkpoint } : {}),
                ...(closedRun.description.version === 3 ? { planRef: closedRun.description.planRef } : {}),
                state, path: runPath(id, request.runId),
            };
        });
    }
    async appendPreparedRunState(session, id, run, signal) {
        const result = run.result;
        if (result === undefined || result.transition.lastRunId !== run.id) {
            invalidRecord(`closed run ${run.id} does not carry its exact state transition`);
        }
        const transition = result.transition;
        const target = await this.readTarget(session, id, signal);
        if (isDeepStrictEqual(target.state, transition))
            return target.state;
        if (target.state.status === 'complete') {
            throw new ResearcherError(`research target ${id} is complete`, 'RESEARCH_TARGET_COMPLETE');
        }
        if (target.state.revision + 1 !== transition.revision) {
            throw new ResearcherError(`closed run ${run.id} prepared transition ${transition.revision}, but target is now at revision ${target.state.revision}`, 'RESEARCH_STALE_WRITE');
        }
        const openRun = await this.findOpenRun(session, id, signal);
        if (openRun !== undefined) {
            throw new ResearcherError(`research run ${openRun} opened before closed run ${run.id} could publish its state`, 'RESEARCH_RUN_OPEN');
        }
        const prospective = {
            ...target,
            recovery: undefined,
            state: transition,
            latestRun: run,
        };
        assertContextFits(session, prospective, transition.at);
        const stateFile = await this.records.readStateLog(session, id, signal);
        const log = stateFile.value;
        const current = log.states.at(-1);
        if (current === undefined)
            invalidRecord(`${statePath(id)} has no current state`);
        if (!isDeepStrictEqual(current, target.state)) {
            throw new ResearcherError(`${statePath(id)} changed while applying run ${run.id}`, 'RESEARCH_STALE_WRITE');
        }
        await this.records.replaceText(session, stateFile, statePath(id), appendStateText(log, transition), signal);
        return transition;
    }
    async updateGlossary(session, idInput, patch, signal) {
        const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput;
        return await (await this.mutex(session, id)).run(async () => {
            if ((patch.terms === undefined || Object.keys(patch.terms).length === 0)
                && (patch.files === undefined || Object.keys(patch.files).length === 0)) {
                invalidRecord('glossary patch must contain at least one terms or files entry');
            }
            const file = await this.records.readGlossary(session, id, signal);
            const current = file.value;
            const terms = { ...current.terms };
            const files = { ...current.files };
            for (const [key, value] of Object.entries(patch.terms ?? {})) {
                if (key.trim().length === 0)
                    invalidRecord('glossary term keys must not be empty');
                if (value === null)
                    delete terms[key];
                else if (value.trim().length === 0)
                    invalidRecord(`glossary term ${JSON.stringify(key)} has an empty value`);
                else
                    terms[key] = value;
            }
            for (const [rawKey, value] of Object.entries(patch.files ?? {})) {
                const key = normalizeProjectRelativePath(rawKey);
                if (value === null)
                    delete files[key];
                else if (value.trim().length === 0)
                    invalidRecord(`glossary file ${JSON.stringify(key)} has an empty value`);
                else
                    files[key] = value;
            }
            const glossary = researchGlossarySchema.parse({ version: 1, terms, files });
            await this.validateGlossaryFiles(session, glossary, [], signal);
            const content = `${JSON.stringify(glossary, null, 2)}\n`;
            if (Buffer.byteLength(content, 'utf8') > RECORD_MAX_BYTES) {
                throw new ResearcherError('glossary.json exceeds 64 KiB', 'RESEARCH_OVERSIZED');
            }
            await this.records.replaceText(session, file, glossaryPath(id), content, signal);
            return {
                researchId: id,
                path: glossaryPath(id),
                termCount: Object.keys(terms).length,
                fileCount: Object.keys(files).length,
            };
        });
    }
    async bindSession(session, idInput, loadedAt, signal) {
        const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput;
        await (await this.mutex(session, id)).run(async () => {
            await this.ensureSessionIndex(session, id, signal, loadedAt);
        });
    }
    async materializeSession(session, idInput, signal) {
        const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput;
        await (await this.mutex(session, id)).run(async () => {
            await this.ensureSessionIndex(session, id, signal);
        });
    }
    async readRun(session, idInput, runIdInput, signal) {
        const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput;
        const runId = typeof runIdInput === 'string' ? parseRunId(runIdInput) : runIdInput;
        return (await this.records.readRun(session, id, runId, signal)).value;
    }
    async ensureSessionIndex(session, id, signal, explicitLoadedAt) {
        const relative = sessionPath(id, String(session.id));
        const runIds = await this.rebuildSessionRunIds(session, id, String(session.id), signal);
        const file = await this.records.readSessionIndex(session, id, signal);
        let loadedAt = explicitLoadedAt ?? nowIso();
        if (file !== undefined)
            loadedAt = explicitLoadedAt ?? file.value.loadedAt;
        const next = researchSessionIndexSchema.parse({
            version: 1,
            sessionId: String(session.id),
            loadedAt,
            runIds,
        });
        const content = `${JSON.stringify(next, null, 2)}\n`;
        if (Buffer.byteLength(content, 'utf8') > SESSION_INDEX_MAX_BYTES) {
            throw new ResearcherError(`${relative} exceeds 1 MiB`, 'RESEARCH_OVERSIZED');
        }
        if (file === undefined) {
            await this.records.createText(session, relative, content, this.records.writePolicy(session), signal);
            return;
        }
        await this.records.replaceText(session, file, relative, content, signal);
    }
    /** No lock here: readTarget is also called by operations already holding this target's FIFO. */
    async readRecovery(session, id, currentRevision, signal) {
        const entries = await this.records.listRunEntries(session, id, signal);
        let recovery;
        for (const entry of entries) {
            if (entry.type !== 'file' || !entry.name.endsWith('.jsonl'))
                continue;
            let runId;
            try {
                runId = parseRunId(entry.name.slice(0, -'.jsonl'.length));
            }
            catch {
                continue;
            }
            const run = await this.readRun(session, id, runId, signal);
            const phase = run.result === undefined ? 'open'
                : run.result.transition.revision === currentRevision + 1 ? 'pending-state' : undefined;
            if (phase === undefined)
                continue;
            if (recovery !== undefined) {
                invalidRecord(`research target ${id} has conflicting recovery runs: ${recovery.runId}, ${runId}`);
            }
            recovery = {
                runId, phase, path: runPath(id, runId),
                ...(isCheckpointRunDescription(run.description) ? { outputRef: run.description.checkpoint.outputRef } : {}),
                ...(run.description.version === 3 ? { planRef: run.description.planRef } : {}),
            };
        }
        return recovery;
    }
    async findPendingTransition(session, id, currentRevision, signal) {
        const relative = `${targetRoot(id)}/runs`;
        await this.records.assertRealDirectory(session, relative, signal);
        const entries = await this.records.listRunEntries(session, id, signal);
        for (const entry of entries) {
            if (entry.type !== 'file' || !entry.name.endsWith('.jsonl'))
                continue;
            let runId;
            try {
                runId = parseRunId(entry.name.slice(0, -'.jsonl'.length));
            }
            catch {
                continue;
            }
            const run = await this.readRun(session, id, runId, signal);
            if (run.result?.transition.revision === currentRevision + 1)
                return runId;
        }
        return undefined;
    }
    async findOpenRun(session, id, signal) {
        const relative = `${targetRoot(id)}/runs`;
        await this.records.assertRealDirectory(session, relative, signal);
        const entries = await this.records.listRunEntries(session, id, signal);
        let open;
        for (const entry of entries) {
            if (entry.type !== 'file' || !entry.name.endsWith('.jsonl'))
                continue;
            let runId;
            try {
                runId = parseRunId(entry.name.slice(0, -'.jsonl'.length));
            }
            catch {
                continue;
            }
            const run = await this.readRun(session, id, runId, signal);
            if (run.result !== undefined)
                continue;
            if (open !== undefined)
                invalidRecord(`research target ${id} contains multiple open runs: ${open}, ${runId}`);
            open = runId;
        }
        return open;
    }
    async rebuildSessionRunIds(session, id, sessionId, signal) {
        const relative = `${targetRoot(id)}/runs`;
        await this.records.assertRealDirectory(session, relative, signal);
        const entries = await this.records.listRunEntries(session, id, signal, true);
        const matches = [];
        for (const entry of entries) {
            if (entry.type !== 'file' || !entry.name.endsWith('.jsonl'))
                continue;
            let runId;
            try {
                runId = parseRunId(entry.name.slice(0, -'.jsonl'.length));
            }
            catch {
                continue;
            }
            const run = await this.readRun(session, id, runId, signal);
            if (run.description.sessionId === sessionId)
                matches.push({ id: runId, createdAt: run.description.createdAt });
        }
        matches.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
        return matches.map(match => match.id);
    }
    async validateGlossaryFiles(session, glossary, warnings, signal) {
        const inspect = await this.records.projectPathInspector(session, signal);
        for (const relative of Object.keys(glossary.files).sort()) {
            const { contained, info } = await inspect(relative);
            if (!contained) {
                throw new ResearcherError(`glossary file escapes the project root through its canonical target: ${relative}`, 'RESEARCH_PATH_INVALID');
            }
            if (info === undefined)
                warnings.push(`glossary file is missing: ${relative}`);
        }
    }
    normalizeArtifactPaths(artifacts) {
        const normalized = [];
        const seen = new Set();
        for (const raw of artifacts) {
            const relative = normalizeProjectRelativePath(raw);
            if (seen.has(relative))
                invalidRecord(`duplicate artifact path: ${relative}`);
            seen.add(relative);
            normalized.push(relative);
        }
        return normalized;
    }
    async validateArtifacts(session, artifacts, signal) {
        const inspect = await this.records.projectPathInspector(session, signal);
        const normalized = this.normalizeArtifactPaths(artifacts);
        for (const relative of normalized) {
            const { contained, info } = await inspect(relative);
            if (!contained) {
                throw new ResearcherError(`artifact escapes the project root through its canonical target: ${relative}`, 'RESEARCH_PATH_INVALID');
            }
            if (info === undefined)
                invalidRecord(`artifact does not exist: ${relative}`);
        }
        return normalized;
    }
    shortError(error) {
        const text = error instanceof Error ? error.message : String(error);
        return text.length <= 180 ? text : `${text.slice(0, 179)}…`;
    }
}
//# sourceMappingURL=research-store.js.map