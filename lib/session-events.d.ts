import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
/** Keep absolute log indices; never fall back when a present new API fails. */
export declare function sessionEvents(session: Session): readonly SessionEvent[];
export declare function sessionNextSeq(session: Session): number;
export declare function sessionEventAt(session: Session, seq: number): SessionEvent | undefined;
/** Check required capabilities before activation starts writing research records. */
export declare function assertSessionEventAccess(session: Session): void;
//# sourceMappingURL=session-events.d.ts.map