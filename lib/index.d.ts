/** Host researcher service: project-file authority, session binding, and Goal activation. */
import type { Context } from '@deepseek-ai/cordis';
import { type Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import type { CreateResearchRequest, FinishResearchRunRequest, ResearchBinding, ResearchCreateResult, ResearchGlossaryPatch, ResearchGlossaryResult, ResearchId, ResearchLoadResult, ResearchReadResult, ResearchRunFinishResult, ResearchRunStartResult, ResearchStateResult, ResearchTargetList, ResearchTargetListRequest, StartResearchRunRequest, UpdateResearchRequest } from './types.ts';
export interface ResearcherBindingProjectionState {
    readonly bindings: Readonly<Record<string, ResearchBinding>>;
    readonly failure: string | null;
}
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionStateMap {
        researcherBinding: ResearcherBindingProjectionState;
    }
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        researcher: ResearcherService;
    }
}
export declare function applyResearcherBindingProjection(state: ResearcherBindingProjectionState, event: import('@deepseek-ai/dsh-session').SessionEvent): ResearcherBindingProjectionState;
export declare const researcherBindingProjectionDefinition: {
    key: "researcherBinding";
    stateVersion: number;
    stateSchema: z.ZodType<ResearcherBindingProjectionState, unknown, z.core.$ZodTypeInternals<ResearcherBindingProjectionState, unknown>>;
    init: () => ResearcherBindingProjectionState;
    apply: typeof applyResearcherBindingProjection;
};
export declare class ResearcherService extends TypertRemoteService {
    static inject: string[];
    private readonly store;
    private readonly activationGates;
    constructor(ctx: Context);
    binding(session: Session): ResearchBinding | undefined;
    list(request: ResearchTargetListRequest, signal?: AbortSignal): Promise<ResearchTargetList>;
    get(agent: Agent, signal?: AbortSignal): Promise<ResearchReadResult>;
    create(agent: Agent, request: CreateResearchRequest, signal?: AbortSignal): Promise<ResearchCreateResult>;
    load(agent: Agent, idInput: ResearchId | string, signal?: AbortSignal): Promise<ResearchLoadResult>;
    updateState(agent: Agent, request: UpdateResearchRequest, signal?: AbortSignal): Promise<ResearchStateResult>;
    startRun(agent: Agent, request: StartResearchRunRequest, signal?: AbortSignal): Promise<ResearchRunStartResult>;
    finishRun(agent: Agent, request: FinishResearchRunRequest, signal?: AbortSignal): Promise<ResearchRunFinishResult>;
    updateGlossary(agent: Agent, patch: ResearchGlossaryPatch, signal?: AbortSignal): Promise<ResearchGlossaryResult>;
    private activate;
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
export type { ResearchRecovery, CreateResearchRequest, FinishResearchRunRequest, ResearchBinding, ResearchCreateResult, ResearchGlossaryPatch, ResearchGlossaryResult, ResearchId, ResearchLoadResult, ResearchReadResult, ResearchRunFinishResult, ResearchRunStartResult, ResearchStateResult, ResearchTargetList, ResearchTargetListRequest, StartResearchRunRequest, UpdateResearchRequest, } from './types.ts';
export { ResearcherError } from './errors.ts';
//# sourceMappingURL=index.d.ts.map