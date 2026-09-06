import { type UserMessage } from '@deepseek-ai/dsh-llm';
import type { ResearchBinding, ResearchContextSnapshot, ResearchRecovery, ResearchTargetSnapshot } from './types.ts';
export declare const PACKAGE_NAME = "dsh-profile-researcher";
export declare function renderResearchRecovery(recovery: ResearchRecovery): string;
export declare function buildResearchContext(target: ResearchTargetSnapshot, binding: ResearchBinding): ResearchContextSnapshot;
export declare function createResearchContextMessage(snapshot: ResearchContextSnapshot): UserMessage;
/** Recover the binding carried by one durable researcher inbox message. */
export declare function researchBindingFromMessage(message: UserMessage): ResearchBinding | undefined;
export declare function researchGoalObjective(target: ResearchTargetSnapshot): string;
export declare function researchMarker(id: string): string;
export declare function markerResearchId(objective: string): string | undefined;
//# sourceMappingURL=context.d.ts.map