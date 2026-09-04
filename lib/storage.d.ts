import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { CreateResearchRequest, FinishResearchRunRequest, ResearchGlossaryPatch, ResearchGlossaryResult, ResearchId, ResearchRun, ResearchRunFinishResult, ResearchRunStartResult, ResearchStateResult, ResearchTargetSnapshot, ResearchTargetSummary, InvalidResearchTargetSummary, RunId, StartResearchRunRequest, UpdateResearchRequest } from './types.ts';
interface TargetListResult {
    readonly targets: readonly ResearchTargetSummary[];
    readonly invalid: readonly InvalidResearchTargetSummary[];
}
/** Authoritative project-file store. It contains no Goal or model-turn policy. */
export declare class ResearchStore {
    private readonly ctx;
    private readonly mutexes;
    private readonly logger;
    constructor(ctx: Context);
    private mutex;
    private workspaceTarget;
    private resolveContained;
    private assertRealDirectory;
    private assertRealFile;
    private resolveAuthorityContained;
    private readVersioned;
    private readStream;
    private writePolicy;
    private createText;
    private replaceText;
    createTarget(session: Session, request: CreateResearchRequest, signal?: AbortSignal): Promise<ResearchTargetSnapshot>;
    readTarget(session: Session, idInput: ResearchId | string, signal?: AbortSignal): Promise<ResearchTargetSnapshot>;
    listTargets(session: Session, signal?: AbortSignal): Promise<TargetListResult>;
    appendState(session: Session, idInput: ResearchId | string, request: UpdateResearchRequest, signal?: AbortSignal): Promise<ResearchStateResult>;
    private appendStateLocked;
    resumeState(session: Session, idInput: ResearchId | string, signal?: AbortSignal): Promise<ResearchTargetSnapshot>;
    startRun(session: Session, idInput: ResearchId | string, request: StartResearchRunRequest, signal?: AbortSignal): Promise<ResearchRunStartResult>;
    finishRun(session: Session, idInput: ResearchId | string, request: FinishResearchRunRequest, signal?: AbortSignal): Promise<ResearchRunFinishResult>;
    private appendPreparedRunState;
    updateGlossary(session: Session, idInput: ResearchId | string, patch: ResearchGlossaryPatch, signal?: AbortSignal): Promise<ResearchGlossaryResult>;
    bindSession(session: Session, idInput: ResearchId | string, loadedAt: string, signal?: AbortSignal): Promise<void>;
    materializeSession(session: Session, idInput: ResearchId | string, signal?: AbortSignal): Promise<void>;
    readRun(session: Session, idInput: ResearchId | string, runIdInput: RunId | string, signal?: AbortSignal): Promise<ResearchRun>;
    private ensureSessionIndex;
    private findPendingTransition;
    private findOpenRun;
    private rebuildSessionRunIds;
    private validateGlossaryFiles;
    private normalizeArtifactPaths;
    private validateArtifacts;
    private shortError;
}
export {};
//# sourceMappingURL=storage.d.ts.map