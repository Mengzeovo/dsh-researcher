import type { Context } from '@deepseek-ai/cordis';
import type { ResearchReadContext } from './view-types.ts';
/** Read operations accept an observed workspace without materializing a Session. */
type ReadContext = Session | ResearchReadContext;
import { type FsTarget, type FsVersion } from '@deepseek-ai/dsh-fs';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { Session } from '@deepseek-ai/dsh-session';
import { type ParsedStateLog } from './jsonl.ts';
import { type ParsedPlanLedger } from './plan-records.ts';
import type { PlanDocument } from './plan-schema.ts';
import { parseGoalMarkdown } from './schema.ts';
import { type ResearchGlossary, type ResearchId, type ResearchRun, type ResearchSessionIndex, type RunId } from './types.ts';
export interface VersionedText {
    readonly relativePath: string;
    readonly target: FsTarget;
    readonly version: FsVersion;
    readonly text: string;
}
/** The parsed value and the exact observation used for a subsequent conditional replacement. */
export interface ObservedRecord<T> extends VersionedText {
    readonly value: T;
}
export declare function targetRoot(id: ResearchId): string;
export declare function statePath(id: ResearchId): string;
export declare function glossaryPath(id: ResearchId): string;
export declare function runPath(id: ResearchId, runId: RunId): string;
export declare function sessionPath(id: ResearchId, sessionId: string): string;
/** Safe project-record I/O. No operation locks, research lifecycle, Goal, context or Git execution. */
export declare class RecordStore {
    private readonly ctx;
    constructor(ctx: Context);
    canonicalWorkspace(session: ReadContext): Promise<string>;
    private workspaceTarget;
    private resolveContained;
    assertRealDirectory(session: ReadContext, relative: string, signal?: AbortSignal): Promise<void>;
    private assertRealFile;
    private resolveAuthorityContained;
    private readVersioned;
    private readStream;
    writePolicy(session: Session): SandboxExecutionPolicy;
    createText(session: Session, relative: string, content: string, policy: SandboxExecutionPolicy, signal?: AbortSignal): Promise<void>;
    replaceText(session: Session, observed: Pick<VersionedText, 'target' | 'version'>, relative: string, content: string, signal?: AbortSignal): Promise<void>;
    readGoal(session: ReadContext, id: ResearchId, signal?: AbortSignal): Promise<ObservedRecord<ReturnType<typeof parseGoalMarkdown>>>;
    readStateLog(session: ReadContext, id: ResearchId, signal?: AbortSignal, maxBytes?: number): Promise<ObservedRecord<ParsedStateLog>>;
    readGlossary(session: ReadContext, id: ResearchId, signal?: AbortSignal): Promise<ObservedRecord<ResearchGlossary>>;
    readRun(session: ReadContext, id: ResearchId, runId: RunId, signal?: AbortSignal): Promise<ObservedRecord<ResearchRun>>;
    readSessionIndex(session: Session, id: ResearchId, signal?: AbortSignal): Promise<ObservedRecord<ResearchSessionIndex> | undefined>;
    listTargetEntries(session: ReadContext, signal?: AbortSignal): Promise<import("@deepseek-ai/dsh-fs").FsDirEntry[]>;
    listRunEntries(session: ReadContext, id: ResearchId, signal?: AbortSignal, verifyDirectory?: boolean): Promise<import("@deepseek-ai/dsh-fs").FsDirEntry[]>;
    private assertPlanDirectories;
    /** Older targets legitimately have no plan directory until their first publication. */
    listPlanEntries(session: ReadContext, id: ResearchId, signal?: AbortSignal): Promise<import("@deepseek-ai/dsh-fs").FsDirEntry[]>;
    listPlanFiles(session: ReadContext, id: ResearchId, planId: number, signal?: AbortSignal): Promise<import("@deepseek-ai/dsh-fs").FsDirEntry[]>;
    readPlanLedger(session: ReadContext, id: ResearchId, planId: number, signal?: AbortSignal, maxBytes?: number): Promise<ObservedRecord<ParsedPlanLedger>>;
    readPlanDocument(session: ReadContext, id: ResearchId, planId: number, revision: number, signal?: AbortSignal): Promise<ObservedRecord<PlanDocument>>;
    /** An unregistered next-version file may be read, but this method never registers it. */
    findPlanDocument(session: Session, id: ResearchId, planId: number, revision: number, signal?: AbortSignal): Promise<ObservedRecord<PlanDocument> | undefined>;
    /** Project references intentionally do not inherit authority-record symlink/type restrictions. */
    projectPathInspector(session: Session, signal?: AbortSignal): Promise<(relative: string) => Promise<{
        contained: false;
        info: undefined;
    } | {
        contained: true;
        info: import("@deepseek-ai/dsh-fs").FsInfo | undefined;
    }>>;
    ensureDirectories(session: Session, relatives: readonly string[]): Promise<SandboxExecutionPolicy>;
    commitDirectory(session: Session, stagingRelative: string, finalRelative: string): Promise<void>;
    discardStaging(session: Session, stagingRelative: string): Promise<void>;
}
export {};
//# sourceMappingURL=record-store.d.ts.map