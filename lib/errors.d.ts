import { HarnessError } from '@deepseek-ai/dsh-llm';
export type ResearcherErrorCode = 'RESEARCH_AUTHORITY_REQUIRED' | 'RESEARCH_CHECKPOINT_INVALID' | 'RESEARCH_DRIVER_REQUIRED' | 'RESEARCH_BRIEFING_FAILED' | 'RESEARCH_GOAL_CONFLICT' | 'RESEARCH_INVALID_RECORD' | 'RESEARCH_NOT_FOUND' | 'RESEARCH_OVERSIZED' | 'RESEARCH_PATH_INVALID' | 'RESEARCH_PLAN_REQUIRED' | 'RESEARCH_PLAN_CONFLICT' | 'RESEARCH_PLAN_INTEGRITY' | 'RESEARCH_PLAN_EVIDENCE' | 'RESEARCH_VIEW_PAGE' | 'RESEARCH_VIEW_STALE' | 'RESEARCH_VIEW_UNAVAILABLE' | 'RESEARCH_RUN_CLOSED' | 'RESEARCH_RUN_OPEN' | 'RESEARCH_SESSION_BOUND' | 'RESEARCH_SESSION_BUSY' | 'RESEARCH_SESSION_ID_TOO_LONG' | 'RESEARCH_SESSION_NOT_LIVE' | 'RESEARCH_SESSION_API_UNSUPPORTED' | 'RESEARCH_STALE_WRITE' | 'RESEARCH_TARGET_COMPLETE' | 'RESEARCH_TARGET_INACTIVE';
export declare class ResearcherError extends HarnessError {
    readonly code: ResearcherErrorCode;
    constructor(message: string, code: ResearcherErrorCode, options?: ErrorOptions);
}
export declare function invalidRecord(message: string, options?: ErrorOptions): never;
//# sourceMappingURL=errors.d.ts.map