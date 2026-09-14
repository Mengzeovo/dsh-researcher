/** Host researcher service: project-file authority, context-only loading, and explicit Goal activation. */
import type { Context } from '@deepseek-ai/cordis';
import { type Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import type { CreateResearchRequest, CreateResearchPlanRequest, UpdateResearchPlanRequest, GetResearchPlanRequest, ListResearchPlansRequest, SelectResearchPlanRequest, ResearchPlanReadResult, ResearchPlanListResult, FinishResearchRunRequest, ResearchBinding, ResearchCreateResult, ResearchGlossaryPatch, ResearchGlossaryResult, ResearchId, ResearchViewClientConfig, ResearchLoadResult, ResearchStartResult, ResearchReadResult, ResearchRunFinishResult, ResearchRunStartResult, ResearchStateResult, ResearchTargetList, ResearchTargetListRequest, StartResearchRunRequest, UpdateResearchRequest } from './types.ts';
import type { ResearchReadContext, ResearchViewConfig, ResearchViewData } from './view-types.ts';
export interface ResearcherBindingProjectionView {
    readonly binding: ResearchBinding | null;
    readonly failure: string | null;
}
export interface ResearcherBindingProjectionState {
    readonly sessionId: string;
    readonly bindings: Readonly<Record<string, ResearchBinding>>;
    readonly failure: string | null;
}
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionMap {
        researcherBinding: ResearcherBindingProjectionView;
    }
    interface SessionProjectionStateMap {
        researcherBinding: ResearcherBindingProjectionState;
    }
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        researcher: ResearcherService;
    }
    interface Events {
        /** @mode broadcast @param value - A successfully committed target mutation. */
        'researcher/changed'(value: {
            readonly workspaceRoot: string;
            readonly researchId: ResearchId;
        }): void;
    }
}
export declare function applyResearcherBindingProjection(state: ResearcherBindingProjectionState, event: import('@deepseek-ai/dsh-session').SessionEvent): ResearcherBindingProjectionState;
declare function bindingWireView(state: ResearcherBindingProjectionState): ResearcherBindingProjectionView;
export declare const researcherBindingProjectionDefinition: {
    key: "researcherBinding";
    stateVersion: number;
    stateSchema: z.ZodType<ResearcherBindingProjectionState, unknown, z.core.$ZodTypeInternals<ResearcherBindingProjectionState, unknown>>;
    init: (header: import("@deepseek-ai/dsh-session").SessionHeader) => ResearcherBindingProjectionState;
    apply: typeof applyResearcherBindingProjection;
    wire: {
        viewSchema: z.ZodObject<{
            binding: z.ZodNullable<z.ZodType<ResearchBinding, unknown, z.core.$ZodTypeInternals<ResearchBinding, unknown>>>;
            failure: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>;
        view: typeof bindingWireView;
    };
};
export declare class ResearcherService extends TypertRemoteService {
    static inject: string[];
    private readonly viewConfig;
    private readonly store;
    private readonly activationGates;
    private readonly loadingSessions;
    private readonly briefings;
    static Config: z.ZodObject<{
        view: z.ZodDefault<z.ZodType<ResearchViewConfig, unknown, z.core.$ZodTypeInternals<ResearchViewConfig, unknown>>>;
    }, z.core.$strict>;
    constructor(ctx: Context, config?: unknown);
    /** Return only browser-public view settings, including when the view service is disabled.
     * No Session, Agent, workspace read, or authority mutation is needed.
     */
    getViewConfig(signal?: AbortSignal): Promise<ResearchViewClientConfig>;
    /** Resolve the canonical read-only workspace for the view consumer. */
    viewWorkspace(context: ResearchReadContext): Promise<string>;
    /** Read verified graph records without agent lookup, activation, or authority mutation. */
    viewData(context: ResearchReadContext, id: ResearchId, config: ResearchViewConfig, signal?: AbortSignal): Promise<ResearchViewData>;
    private publishMutation;
    binding(session: Session): ResearchBinding | undefined;
    list(request: ResearchTargetListRequest, signal?: AbortSignal): Promise<ResearchTargetList>;
    get(agent: Agent, signal?: AbortSignal): Promise<ResearchReadResult>;
    create(agent: Agent, request: CreateResearchRequest, signal?: AbortSignal): Promise<ResearchCreateResult>;
    load(agent: Agent, idInput: ResearchId | string, signal?: AbortSignal): Promise<ResearchLoadResult>;
    /** Start only the already-bound target after explicit human authorization at the command/tool boundary. */
    start(agent: Agent, signal?: AbortSignal): Promise<ResearchStartResult>;
    private assertLoadIdle;
    createPlan(agent: Agent, request: CreateResearchPlanRequest, signal?: AbortSignal): Promise<ResearchPlanReadResult>;
    updatePlan(agent: Agent, request: UpdateResearchPlanRequest, signal?: AbortSignal): Promise<ResearchPlanReadResult>;
    getPlan(agent: Agent, request: GetResearchPlanRequest, signal?: AbortSignal): Promise<ResearchPlanReadResult>;
    listPlans(agent: Agent, request: ListResearchPlansRequest, signal?: AbortSignal): Promise<ResearchPlanListResult>;
    selectPlan(agent: Agent, request: SelectResearchPlanRequest, signal?: AbortSignal): Promise<ResearchStateResult>;
    updateState(agent: Agent, request: UpdateResearchRequest, signal?: AbortSignal): Promise<ResearchStateResult>;
    startRun(agent: Agent, request: StartResearchRunRequest, signal?: AbortSignal): Promise<ResearchRunStartResult>;
    finishRun(agent: Agent, request: FinishResearchRunRequest, signal?: AbortSignal): Promise<ResearchRunFinishResult>;
    updateGlossary(agent: Agent, patch: ResearchGlossaryPatch, signal?: AbortSignal): Promise<ResearchGlossaryResult>;
    private activate;
    private injectContext;
    private assertCreateCompatible;
    private assertBindingCompatible;
    private assertGoalCompatible;
    private assertGoalActivationCapacity;
    private activationGate;
    private applyGoalActivation;
    private requireBinding;
}
export declare const name = "researcher";
export declare const inject: string[];
export default ResearcherService;
export type { PlanVersionRef, PlanContentInput, PlanMetadata, PlanDocument, PlanLedgerEntry } from './plan-schema.ts';
export type { ResearchRecovery, CreateResearchRequest, CreateResearchPlanRequest, UpdateResearchPlanRequest, GetResearchPlanRequest, ListResearchPlansRequest, SelectResearchPlanRequest, ResearchPlanReadResult, ResearchPlanListResult, FinishResearchRunRequest, ResearchBinding, ResearchCreateResult, ResearchGlossaryPatch, ResearchGlossaryResult, ResearchId, ResearchViewClientConfig, ResearchLoadResult, ResearchActivationResult, ResearchStartResult, ResearchReadResult, ResearchRunFinishResult, ResearchRunStartResult, ResearchStateResult, ResearchTargetList, ResearchTargetListRequest, StartResearchRunRequest, UpdateResearchRequest, } from './types.ts';
export { ResearcherError } from './errors.ts';
//# sourceMappingURL=index.d.ts.map