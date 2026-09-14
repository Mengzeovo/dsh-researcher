import { Buffer } from 'node:buffer';
import path from 'node:path';
import { z } from 'zod';
import { isCheckpointRunResult, samePlanVersionRef } from "./types.js";
import { planVersionRefSchema } from "./plan-schema.js";
import { ResearcherError, invalidRecord } from "./errors.js";
import { UUID_PATTERN, researchIdSchema, researchStatusSchema } from "./wire.js";
export { invalidResearchTargetSummarySchema, researchIdSchema, researchStatusSchema, researchTargetListRequestSchema, researchTargetListSchema, researchTargetSummarySchema, } from "./wire.js";
export const RECORD_MAX_BYTES = 64 * 1024;
export const SESSION_INDEX_MAX_BYTES = 1024 * 1024;
export const CONTEXT_MAX_CHARS = 32 * 1024;
export const POPUP_LABEL_MAX_CHARS = 120;
export const SESSION_FILENAME_MAX_CHARS = 240;
const nonBlank = z.string().refine(value => value.trim().length > 0, 'must contain a non-whitespace character');
const isoUtc = z.string().refine(value => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}, 'must be an ISO-8601 UTC timestamp produced by Date.toISOString()');
const positiveRevision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const jsonRecord = z.record(z.string(), z.json());
export const runIdSchema = z.string().regex(UUID_PATTERN).transform(value => value);
const stateFields = {
    revision: positiveRevision,
    at: isoUtc,
    sessionId: nonBlank,
    status: researchStatusSchema,
    summary: nonBlank,
    direction: nonBlank.optional(),
    next: nonBlank.optional(),
    lastRunId: runIdSchema.optional(),
};
export const researchStateV1Schema = z.object({ version: z.literal(1), ...stateFields }).strict();
export const researchStateV2Schema = z.object({
    version: z.literal(2), ...stateFields, selectedPlanRef: planVersionRefSchema.optional(),
}).strict();
/** Reading legacy snapshots never manufactures a selection or changes their version. */
export const researchStateSchema = z.discriminatedUnion('version', [
    researchStateV1Schema, researchStateV2Schema,
]);
const glossaryMapSchema = z.record(nonBlank, nonBlank);
export const researchGlossarySchema = z.object({
    version: z.literal(1),
    terms: glossaryMapSchema,
    files: glossaryMapSchema,
}).strict().superRefine((value, ctx) => {
    for (const key of Object.keys(value.files)) {
        try {
            const normalized = normalizeProjectRelativePath(key);
            if (normalized !== key) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['files', key],
                    message: `path must use canonical project-relative spelling ${JSON.stringify(normalized)}`,
                });
            }
        }
        catch (error) {
            ctx.addIssue({
                code: 'custom',
                path: ['files', key],
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
});
const checkpointPath = nonBlank.refine(value => {
    try {
        return normalizeProjectRelativePath(value) === value
            && !value.split('/').some(part => part === '.git' || part === '.research')
            && !/[\x00-\x1f\x7f]/u.test(value);
    }
    catch {
        return false;
    }
}, 'must be a canonical project file path outside Git/research metadata');
const uniquePaths = z.array(checkpointPath).max(2000).refine(paths => new Set(paths).size === paths.length, 'duplicate paths');
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const checkpointRef = z.string().regex(/^refs\/dsh\/research\/[0-9a-f-]+\/runs\/[0-9a-f-]+\/(?:input|output)$/u);
export const reproductionSchema = z.object({
    command: nonBlank,
    cwd: z.union([z.literal('.'), checkpointPath]),
    environment: jsonRecord,
    inputs: uniquePaths,
}).strict();
export const inputCheckpointSchema = z.object({
    backend: z.literal('git'),
    inputRef: checkpointRef,
    outputRef: checkpointRef,
    inputCommit: oid,
    inputTree: oid,
    baseHead: oid,
    objectFormat: z.enum(['sha1', 'sha256']),
    files: uniquePaths,
    reproduction: reproductionSchema,
}).strict();
export const outputCheckpointSchema = z.object({
    backend: z.literal('git'),
    inputRef: checkpointRef,
    outputRef: checkpointRef,
    inputCommit: oid,
    outputCommit: oid,
    inputTree: oid,
    outputTree: oid,
    objectFormat: z.enum(['sha1', 'sha256']),
    codeChanged: z.boolean(),
    artifacts: z.array(z.object({
        path: checkpointPath,
        sha256: z.string().regex(/^[0-9a-f]{64}$/u),
        bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }).strict()).max(2000),
}).strict();
const descriptionFields = {
    type: z.literal('description'),
    createdAt: isoUtc,
    sessionId: nonBlank,
    purpose: nonBlank,
    parameters: jsonRecord,
};
export const researchRunDescriptionSchema = z.discriminatedUnion('version', [
    z.object({ version: z.literal(1), ...descriptionFields }).strict(),
    z.object({ version: z.literal(2), ...descriptionFields, baseStateRevision: positiveRevision, checkpoint: inputCheckpointSchema }).strict(),
    z.object({ version: z.literal(3), ...descriptionFields, baseStateRevision: positiveRevision, checkpoint: inputCheckpointSchema, planRef: planVersionRefSchema }).strict(),
]);
const resultFields = {
    type: z.literal('result'),
    finishedAt: isoUtc,
    status: z.enum(['completed', 'failed']),
    result: nonBlank,
    metrics: jsonRecord,
    decision: nonBlank,
    artifacts: z.array(nonBlank),
    transition: researchStateSchema,
};
const legacyResultObject = z.object({ version: z.literal(1), ...resultFields }).strict();
const planResultFields = {
    ...resultFields,
    version: z.literal(3),
    artifacts: uniquePaths,
    planRef: planVersionRefSchema,
    transition: researchStateV2Schema.extend({ selectedPlanRef: planVersionRefSchema }),
};
const preparedPlanResultObject = z.object(planResultFields).strict();
function validateResultArtifacts(value, ctx) {
    value.artifacts.forEach((artifact, index) => {
        try {
            normalizeProjectRelativePath(artifact);
        }
        catch (error) {
            ctx.addIssue({ code: 'custom', path: ['artifacts', index], message: error instanceof Error ? error.message : String(error) });
        }
    });
}
function validatePlanSelection(value, ctx) {
    if (!samePlanVersionRef(value.planRef, value.transition.selectedPlanRef)) {
        ctx.addIssue({ code: 'custom', path: ['transition', 'selectedPlanRef'], message: 'prepared state selection must match the exact run plan reference' });
    }
}
/** A journal payload has no checkpoint: its output commit does not exist yet. */
export const preparedPlanRunResultSchema = preparedPlanResultObject.superRefine(validatePlanSelection);
export const researchPreparedRunResultSchema = z.discriminatedUnion('version', [
    legacyResultObject, preparedPlanResultObject,
]).superRefine((value, ctx) => {
    validateResultArtifacts(value, ctx);
    if (value.version === 3)
        validatePlanSelection(value, ctx);
});
export const researchRunResultSchema = z.discriminatedUnion('version', [
    legacyResultObject,
    z.object({ version: z.literal(2), ...resultFields, checkpoint: outputCheckpointSchema }).strict(),
    z.object({ ...planResultFields, checkpoint: outputCheckpointSchema }).strict(),
]).superRefine((value, ctx) => {
    validateResultArtifacts(value, ctx);
    if (isCheckpointRunResult(value) && (new Set(value.artifacts).size !== value.artifacts.length
        || JSON.stringify(value.artifacts) !== JSON.stringify(value.checkpoint.artifacts.map(item => item.path)))) {
        ctx.addIssue({ code: 'custom', path: ['checkpoint', 'artifacts'], message: 'checkpoint digests must match the exact artifact list' });
    }
    if (value.version === 3)
        validatePlanSelection(value, ctx);
});
export const researchSessionIndexSchema = z.object({
    version: z.literal(1),
    sessionId: nonBlank,
    loadedAt: isoUtc,
    runIds: z.array(runIdSchema).superRefine((ids, ctx) => {
        const seen = new Set();
        ids.forEach((id, index) => {
            if (seen.has(id))
                ctx.addIssue({ code: 'custom', path: [index], message: `duplicate run id ${id}` });
            seen.add(id);
        });
    }),
}).strict();
export const researchBindingSchema = z.object({
    version: z.literal(1),
    researchId: researchIdSchema,
    sessionId: nonBlank,
    loadedAt: isoUtc,
}).strict();
export function parseResearchId(value) {
    const parsed = researchIdSchema.safeParse(value);
    if (!parsed.success)
        throw new ResearcherError(`invalid research id: ${JSON.stringify(value)}`, 'RESEARCH_PATH_INVALID');
    return parsed.data;
}
export function parseRunId(value) {
    const parsed = runIdSchema.safeParse(value);
    if (!parsed.success)
        throw new ResearcherError(`invalid run id: ${JSON.stringify(value)}`, 'RESEARCH_PATH_INVALID');
    return parsed.data;
}
export function parseGoalMarkdown(markdown) {
    assertUtf8Bound('goal.md', markdown, RECORD_MAX_BYTES);
    const normalized = markdown.replace(/\r\n?/gu, '\n');
    const headings = ['# Goal', '## Metrics', '## Baseline'];
    const positions = headings.map(heading => {
        const matches = [];
        const lines = normalized.split('\n');
        let offset = 0;
        for (const line of lines) {
            if (line === heading)
                matches.push(offset);
            offset += line.length + 1;
        }
        if (matches.length !== 1)
            invalidRecord(`goal.md must contain exactly one ${heading} heading`);
        return matches[0];
    });
    const [goalPosition, metricsPosition, baselinePosition] = positions;
    if (goalPosition === undefined || metricsPosition === undefined || baselinePosition === undefined) {
        invalidRecord('goal.md is missing one of its required headings');
    }
    if (!(goalPosition < metricsPosition && metricsPosition < baselinePosition)) {
        invalidRecord('goal.md headings must be ordered as # Goal, ## Metrics, ## Baseline');
    }
    const bodyAfter = (heading, start, end) => {
        const from = start + heading.length;
        return normalized.slice(from, end).trim();
    };
    const goal = bodyAfter(headings[0], goalPosition, metricsPosition);
    const metrics = bodyAfter(headings[1], metricsPosition, baselinePosition);
    const baseline = bodyAfter(headings[2], baselinePosition);
    if (goal.length === 0)
        invalidRecord('goal.md # Goal section must not be empty');
    if (metrics.length === 0)
        invalidRecord('goal.md ## Metrics section must not be empty');
    if (baseline.length === 0)
        invalidRecord('goal.md ## Baseline section must not be empty');
    const description = firstParagraph(goal);
    return Object.freeze({ markdown: normalized, goal, metrics, baseline, description });
}
export function renderGoalMarkdown(goal, metrics, baseline) {
    const cleanGoal = requireNonBlank('goal', goal);
    const cleanBaseline = requireNonBlank('baseline', baseline);
    if (metrics.length === 0)
        invalidRecord('metrics must contain at least one item');
    const cleanMetrics = metrics.map((metric, index) => requireNonBlank(`metrics[${index}]`, metric));
    const markdown = `# Goal\n${cleanGoal}\n\n## Metrics\n${cleanMetrics.map(metric => `- ${metric}`).join('\n')}\n\n## Baseline\n${cleanBaseline}\n`;
    parseGoalMarkdown(markdown);
    return markdown;
}
export function firstParagraph(value) {
    const paragraph = value.split(/\n\s*\n/u).map(part => part.trim()).find(Boolean);
    if (paragraph === undefined)
        invalidRecord('goal has no non-empty paragraph');
    return paragraph.replace(/\s+/gu, ' ').trim();
}
export function truncateLabel(value) {
    if (value.length <= POPUP_LABEL_MAX_CHARS)
        return value;
    return `${value.slice(0, POPUP_LABEL_MAX_CHARS - 1)}…`;
}
export function normalizeProjectRelativePath(value) {
    if (value.trim() !== value || value.length === 0) {
        throw new ResearcherError('project-relative path must be non-empty and have no surrounding whitespace', 'RESEARCH_PATH_INVALID');
    }
    const slashed = value.replace(/\\/gu, '/');
    if (path.posix.isAbsolute(slashed) || /^[A-Za-z]:\//u.test(slashed)) {
        throw new ResearcherError(`absolute path is not allowed: ${JSON.stringify(value)}`, 'RESEARCH_PATH_INVALID');
    }
    const segments = slashed.split('/');
    if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
        throw new ResearcherError(`path contains an empty, dot, or parent segment: ${JSON.stringify(value)}`, 'RESEARCH_PATH_INVALID');
    }
    const normalized = path.posix.normalize(slashed);
    if (normalized !== slashed || normalized.startsWith('../')) {
        throw new ResearcherError(`path is not canonical project-relative form: ${JSON.stringify(value)}`, 'RESEARCH_PATH_INVALID');
    }
    return normalized;
}
export function encodeSessionId(sessionId) {
    requireNonBlank('sessionId', sessionId);
    const encoded = Buffer.from(sessionId, 'utf8').toString('base64url');
    if (encoded.length > SESSION_FILENAME_MAX_CHARS) {
        throw new ResearcherError('encoded DSH session id exceeds the safe filename limit', 'RESEARCH_SESSION_ID_TOO_LONG');
    }
    return encoded;
}
export function decodeSessionId(encoded) {
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded))
        invalidRecord(`invalid base64url session filename: ${encoded}`);
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    if (encodeSessionId(decoded) !== encoded)
        invalidRecord(`non-canonical base64url session filename: ${encoded}`);
    return decoded;
}
export function assertUtf8Bound(subject, value, maxBytes) {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > maxBytes) {
        throw new ResearcherError(`${subject} exceeds ${maxBytes} UTF-8 bytes`, 'RESEARCH_OVERSIZED');
    }
}
export function parseJsonText(subject, text, schema, maxBytes) {
    assertUtf8Bound(subject, text, maxBytes);
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (error) {
        invalidRecord(`${subject} is not valid JSON`, { cause: error });
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
        invalidRecord(`${subject} does not match schema: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
}
export function stableJsonLine(value) {
    const text = JSON.stringify(value);
    if (text === undefined)
        invalidRecord('record is not losslessly JSON serializable');
    assertUtf8Bound('JSONL record', text, RECORD_MAX_BYTES);
    return text;
}
export function requireNonBlank(subject, value) {
    if (value.trim().length === 0)
        invalidRecord(`${subject} must contain a non-whitespace character`);
    return value.trim();
}
export function nowIso() {
    return new Date().toISOString();
}
//# sourceMappingURL=schema.js.map