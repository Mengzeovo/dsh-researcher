import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
/**
 * One-shot, tool-free briefing reservations for live agents. The caller must
 * inject research context first and synchronously queue the briefing while the
 * agent is idle, with no queued follow-up and with automatic Goal driving disarmed.
 * Reservations are process-local: persisted canceled/resumed briefings never replay.
 */
export declare class ResearchBriefings {
    private readonly ctx;
    private readonly reservations;
    private readonly moving;
    private stopping;
    /** Install scoped-capable Host hooks; the Context owns their complete teardown. */
    constructor(ctx: Context);
    /** Whether this exact live agent already has a queued or admitted briefing. */
    busy(agent: Agent): boolean;
    /** Reserve before waking the loop; callers must not await between context injection and this call. */
    queue(agent: Agent): void;
    /**
     * Durable parking uses existing inbox messages, not a volatile deferred queue.
     * The marker can cause one rejected empty turn, but never a model request.
     * Original notification identities and sources survive cancellation/restart.
     */
    private park;
    private admitParked;
    /** Distinguish our requeues from an external cancel/clear operation. */
    private remove;
    private retire;
}
//# sourceMappingURL=briefing.d.ts.map