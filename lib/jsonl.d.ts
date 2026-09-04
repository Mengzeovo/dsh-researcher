import type { ResearchRun, ResearchRunDescription, ResearchRunResult, ResearchState, RunId } from './types.ts';
export interface ParsedStateLog {
    readonly states: readonly ResearchState[];
    readonly validText: string;
    readonly warning?: string;
}
export declare function parseStateLog(text: string): ParsedStateLog;
export declare function appendStateText(parsed: ParsedStateLog, state: ResearchState): string;
export declare function parseRunLog(runId: RunId, text: string): ResearchRun;
export declare function renderOpenRun(description: ResearchRunDescription): string;
export declare function renderClosedRun(description: ResearchRunDescription, result: ResearchRunResult): string;
//# sourceMappingURL=jsonl.d.ts.map