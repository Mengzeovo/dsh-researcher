import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { ResearchId } from './types.ts';
export interface ResearchToolExecution {
    readonly agent: Agent;
    readonly events: readonly SessionEvent[];
    readonly openTurnStartSeq: number;
}
export declare function researchToolExecution(ctx: Context, exec: ToolRunContext): ResearchToolExecution;
export declare function requireDirectHuman(ctx: Context, execution: ResearchToolExecution): void;
export declare function requireResearchMutation(ctx: Context, execution: ResearchToolExecution, id: ResearchId): void;
//# sourceMappingURL=authority.d.ts.map