import { realpath } from 'node:fs/promises';
import { FsError } from '@deepseek-ai/dsh-fs';
import { commitResearchDirectory, discardResearchStaging, ensureResearchDirectories } from "./directories.js";
import { ResearcherError, invalidRecord } from "./errors.js";
import { parseRunLog, parseStateLog } from "./jsonl.js";
import { RECORD_MAX_BYTES, SESSION_INDEX_MAX_BYTES, encodeSessionId, parseGoalMarkdown, parseJsonText, researchGlossarySchema, researchSessionIndexSchema } from "./schema.js";
function sessionCwd(session) {
    const cwd = session.header.cwd;
    if (cwd === undefined)
        throw new ResearcherError('researcher requires a session workspace cwd', 'RESEARCH_PATH_INVALID');
    return cwd;
}
function pathOptions(session, signal) {
    const cwd = sessionCwd(session);
    return signal === undefined ? { cwd } : { cwd, signal };
}
export function targetRoot(id) {
    return `.research/goal/${id}`;
}
export function statePath(id) {
    return `${targetRoot(id)}/state.jsonl`;
}
export function glossaryPath(id) {
    return `${targetRoot(id)}/glossary.json`;
}
export function runPath(id, runId) {
    return `${targetRoot(id)}/runs/${runId}.jsonl`;
}
export function sessionPath(id, sessionId) {
    return `${targetRoot(id)}/session/${encodeSessionId(sessionId)}.json`;
}
function mapWriteError(error, subject) {
    if (error instanceof FsError && (error.code === 'FS_STALE_VERSION' || error.code === 'FS_NOT_OBSERVED')) {
        throw new ResearcherError(`${subject} changed concurrently; reload and retry`, 'RESEARCH_STALE_WRITE', { cause: error });
    }
    throw error;
}
/** Safe project-record I/O. No operation locks, research lifecycle, Goal, context or Git execution. */
export class RecordStore {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    async canonicalWorkspace(session) {
        return await realpath(sessionCwd(session));
    }
    async workspaceTarget(session, signal) {
        const target = await this.ctx.fs.resolve('.', pathOptions(session, signal));
        const info = await this.ctx.fs.stat(target, signal);
        if (info?.type !== 'directory') {
            throw new ResearcherError('session workspace is not an accessible directory', 'RESEARCH_PATH_INVALID');
        }
        return target;
    }
    async resolveContained(session, relative, signal) {
        const root = await this.workspaceTarget(session, signal);
        const target = await this.ctx.fs.resolve(relative, pathOptions(session, signal));
        if (!this.ctx.fs.contains(root, target)) {
            throw new ResearcherError(`research path escapes the project root: ${relative}`, 'RESEARCH_PATH_INVALID');
        }
        return target;
    }
    async assertRealDirectory(session, relative, signal) {
        const info = await this.ctx.fs.lstat(relative, { cwd: sessionCwd(session) }, signal);
        if (info === undefined)
            throw new ResearcherError(`missing research directory: ${relative}`, 'RESEARCH_NOT_FOUND');
        if (info.type !== 'directory') {
            throw new ResearcherError(`research directory is a symlink or non-directory: ${relative}`, 'RESEARCH_PATH_INVALID');
        }
    }
    async assertRealFile(session, relative, signal) {
        const info = await this.ctx.fs.lstat(relative, { cwd: sessionCwd(session) }, signal);
        if (info === undefined)
            throw new ResearcherError(`research file not found: ${relative}`, 'RESEARCH_NOT_FOUND');
        if (info.type !== 'file') {
            throw new ResearcherError(`research authority file is a symlink or non-file: ${relative}`, 'RESEARCH_PATH_INVALID');
        }
    }
    async resolveAuthorityContained(session, id, relative, signal) {
        const root = await this.resolveContained(session, targetRoot(id), signal);
        const target = await this.resolveContained(session, relative, signal);
        if (!this.ctx.fs.contains(root, target)) {
            throw new ResearcherError(`research authority path escapes target ${id}: ${relative}`, 'RESEARCH_PATH_INVALID');
        }
        return target;
    }
    async readVersioned(session, id, relative, maxBytes, signal) {
        await this.assertRealFile(session, relative, signal);
        const target = await this.resolveAuthorityContained(session, id, relative, signal);
        const info = await this.ctx.fs.stat(target, signal);
        if (info === undefined)
            throw new ResearcherError(`research file not found: ${relative}`, 'RESEARCH_NOT_FOUND');
        if (info.type !== 'file')
            throw new ResearcherError(`research path is not a regular file: ${relative}`, 'RESEARCH_INVALID_RECORD');
        if (maxBytes !== undefined && info.size !== undefined && info.size > maxBytes) {
            throw new ResearcherError(`${relative} exceeds ${maxBytes} bytes`, 'RESEARCH_OVERSIZED');
        }
        const text = maxBytes === undefined
            ? await this.readStream(target, signal)
            : await this.ctx.fs.readText(target, signal);
        if (maxBytes !== undefined && Buffer.byteLength(text, 'utf8') > maxBytes) {
            throw new ResearcherError(`${relative} exceeds ${maxBytes} bytes`, 'RESEARCH_OVERSIZED');
        }
        return { relativePath: relative, target, version: info.version, text };
    }
    async readStream(target, signal) {
        const stream = await this.ctx.fs.streamText(target, signal);
        let text = '';
        for await (const chunk of stream)
            text += chunk;
        return text;
    }
    writePolicy(session) {
        const policy = this.ctx.sandboxPolicy.resolve({ session });
        if (policy.mode === 'read-only') {
            throw new ResearcherError('research project records cannot be changed while the session is read-only', 'RESEARCH_PATH_INVALID');
        }
        return policy;
    }
    async createText(session, relative, content, policy, signal) {
        const target = await this.resolveContained(session, relative, signal);
        try {
            await this.ctx.fs.writeText(target, content, { kind: 'createIfAbsent' }, signal, policy);
        }
        catch (error) {
            mapWriteError(error, relative);
        }
    }
    async replaceText(session, observed, relative, content, signal) {
        try {
            await this.ctx.fs.writeText(observed.target, content, { kind: 'replaceIfVersion', version: observed.version }, signal, this.writePolicy(session));
        }
        catch (error) {
            mapWriteError(error, relative);
        }
    }
    async readGoal(session, id, signal) {
        const file = await this.readVersioned(session, id, `${targetRoot(id)}/goal.md`, RECORD_MAX_BYTES, signal);
        return { ...file, value: parseGoalMarkdown(file.text) };
    }
    async readStateLog(session, id, signal) {
        const file = await this.readVersioned(session, id, statePath(id), undefined, signal);
        return { ...file, value: parseStateLog(file.text) };
    }
    async readGlossary(session, id, signal) {
        const file = await this.readVersioned(session, id, glossaryPath(id), RECORD_MAX_BYTES, signal);
        return { ...file, value: parseJsonText(file.relativePath, file.text, researchGlossarySchema, RECORD_MAX_BYTES) };
    }
    async readRun(session, id, runId, signal) {
        const file = await this.readVersioned(session, id, runPath(id, runId), undefined, signal);
        const run = parseRunLog(runId, file.text);
        if (run.description.version === 2) {
            const expected = 'refs/dsh/research/' + id + '/runs/' + run.id;
            if (run.description.checkpoint.inputRef !== expected + '/input'
                || run.description.checkpoint.outputRef !== expected + '/output') {
                invalidRecord('run checkpoint refs belong to a different research target');
            }
        }
        return { ...file, value: run };
    }
    async readSessionIndex(session, id, signal) {
        const relative = sessionPath(id, String(session.id));
        const target = await this.resolveAuthorityContained(session, id, relative, signal);
        const linkInfo = await this.ctx.fs.lstat(relative, { cwd: sessionCwd(session) }, signal);
        if (linkInfo !== undefined && linkInfo.type !== 'file') {
            throw new ResearcherError(`research session index is a symlink or non-file: ${relative}`, 'RESEARCH_PATH_INVALID');
        }
        const info = await this.ctx.fs.stat(target, signal);
        if (info === undefined)
            return undefined;
        if (info.type !== 'file')
            invalidRecord(`${relative} is not a regular file`);
        if (info.size !== undefined && info.size > SESSION_INDEX_MAX_BYTES) {
            throw new ResearcherError(`${relative} exceeds 1 MiB`, 'RESEARCH_OVERSIZED');
        }
        const text = await this.ctx.fs.readText(target, signal);
        const value = parseJsonText(relative, text, researchSessionIndexSchema, SESSION_INDEX_MAX_BYTES);
        if (value.sessionId !== String(session.id)) {
            invalidRecord(`${relative} sessionId does not match its reversible filename`);
        }
        return { relativePath: relative, target, version: info.version, text, value };
    }
    async listTargetEntries(session, signal) {
        const root = await this.resolveContained(session, '.research/goal', signal);
        const info = await this.ctx.fs.stat(root, signal);
        if (info === undefined)
            return [];
        if (info.type !== 'directory') {
            throw new ResearcherError('.research/goal is not a directory', 'RESEARCH_PATH_INVALID');
        }
        await this.assertRealDirectory(session, '.research', signal);
        await this.assertRealDirectory(session, '.research/goal', signal);
        return await this.ctx.fs.listDir(root, signal);
    }
    async listRunEntries(session, id, signal, verifyDirectory = false) {
        const directory = await this.resolveAuthorityContained(session, id, `${targetRoot(id)}/runs`, signal);
        if (verifyDirectory) {
            const info = await this.ctx.fs.stat(directory, signal);
            if (info?.type !== 'directory')
                invalidRecord(`${targetRoot(id)}/runs is not a directory`);
        }
        return await this.ctx.fs.listDir(directory, signal);
    }
    /** Project references intentionally do not inherit authority-record symlink/type restrictions. */
    async projectPathInspector(session, signal) {
        const root = await this.workspaceTarget(session, signal);
        return async (relative) => {
            const target = await this.ctx.fs.resolve(relative, pathOptions(session, signal));
            if (!this.ctx.fs.contains(root, target))
                return { contained: false, info: undefined };
            return { contained: true, info: await this.ctx.fs.stat(target, signal) };
        };
    }
    async ensureDirectories(session, relatives) {
        return await ensureResearchDirectories(this.ctx, session, relatives);
    }
    async commitDirectory(session, stagingRelative, finalRelative) {
        await commitResearchDirectory(this.ctx, session, stagingRelative, finalRelative);
    }
    async discardStaging(session, stagingRelative) {
        await discardResearchStaging(this.ctx, session, stagingRelative);
    }
}
//# sourceMappingURL=record-store.js.map