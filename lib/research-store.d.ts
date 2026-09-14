import { GitCheckpointProvider } from './checkpoint.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { CreateResearchRequest, CreateResearchPlanRequest, UpdateResearchPlanRequest, GetResearchPlanRequest, ListResearchPlansRequest, SelectResearchPlanRequest, ResearchPlanReadResult, ResearchPlanListResult, FinishResearchRunRequest, ResearchGlossaryPatch, ResearchGlossaryResult, ResearchId, ResearchRun, ResearchRunFinishResult, ResearchRunStartResult, ResearchStateResult, ResearchTargetSnapshot, ResearchTargetSummary, InvalidResearchTargetSummary, RunId, StartResearchRunRequest, UpdateResearchRequest } from './types.ts';
interface TargetListResult {
    readonly targets: readonly ResearchTargetSummary[];
    readonly invalid: readonly InvalidResearchTargetSummary[];
}
import type { ResearchReadContext, ResearchViewConfig, ResearchViewData } from './view-types.ts';
/** Research operation coordinator. Owns complete-operation locks and publication policy, not file I/O or Goal policy. */
export declare class ResearchStore {
    private readonly checkpoints;
    private readonly mutexes;
    private readonly logger;
    private readonly records;
    constructor(ctx: Context, checkpoints?: Pick<GitCheckpointProvider, 'start' | 'finish'>);
    private mutex;
    /** Resolve the filesystem identity used by both writer locks and read-only views. */
    canonicalWorkspace(context: Session | ResearchReadContext): Promise<string>;
    /** Read graph records under the writer's target lock without creating a Session or Agent. */
    readViewData(context: ResearchReadContext, id: ResearchId, config: ResearchViewConfig, signal?: AbortSignal): Promise<ResearchViewData>;
    createTarget(session: Session, request: CreateResearchRequest, signal?: AbortSignal): Promise<ResearchTargetSnapshot>;
    readTarget(session: Session, idInput: ResearchId | string, signal?: AbortSignal): Promise<ResearchTargetSnapshot>;
    listTargets(session: Session, signal?: AbortSignal): Promise<TargetListResult>;
    createPlan(session: Session, idInput: ResearchId | string, request: CreateResearchPlanRequest, signal?: AbortSignal): Promise<ResearchPlanReadResult>;
    getPlan(session: Session, idInput: ResearchId | string, request: GetResearchPlanRequest, signal?: AbortSignal): Promise<ResearchPlanReadResult>;
    private readPlanLocked;
    listPlans(session: Session, idInput: ResearchId | string, request?: ListResearchPlansRequest, signal?: AbortSignal): Promise<ResearchPlanListResult>;
    updatePlan(session: Session, idInput: ResearchId | string, request: UpdateResearchPlanRequest, signal?: AbortSignal): Promise<ResearchPlanReadResult>;
    /** Call under the target mutex; evidence only points to committed, earlier versions. */
    private resolvePlanEvidence;
    selectPlan(session: Session, idInput: ResearchId | string, request: SelectResearchPlanRequest, signal?: AbortSignal): Promise<ResearchStateResult>;
    private verifyPlanRef;
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
    /** No lock here: readTarget is also called by operations already holding this target's FIFO. */
    private readRecovery;
    private findPendingTransition;
    private findOpenRun;
    private rebuildSessionRunIds;
    private validateGlossaryFiles;
    private normalizeArtifactPaths;
    private validateArtifacts;
    private shortError;
}
export {};
//# sourceMappingURL=research-store.d.ts.map