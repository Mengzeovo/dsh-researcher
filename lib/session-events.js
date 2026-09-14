import { ResearcherError } from "./errors.js";
function unsupported(detail) {
    throw new ResearcherError(`unsupported Session event API: ${detail}`, 'RESEARCH_SESSION_API_UNSUPPORTED');
}
function eventArray(value, member) {
    if (!Array.isArray(value))
        unsupported(`${member} must provide an event array`);
    return value;
}
function legacyEvents(session) {
    return eventArray(session.events, 'events');
}
/** Keep absolute log indices; never fall back when a present new API fails. */
export function sessionEvents(session) {
    const access = session;
    if (access.snapshotEvents !== undefined) {
        if (typeof access.snapshotEvents !== 'function')
            unsupported('snapshotEvents must be a function');
        return eventArray(access.snapshotEvents.call(session), 'snapshotEvents()');
    }
    // A defensive copy also keeps legacy test/host arrays stable after append.
    return Object.freeze(legacyEvents(access).slice());
}
export function sessionNextSeq(session) {
    const access = session;
    if (access.seq === undefined)
        return legacyEvents(access).length;
    const seq = access.seq;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
        unsupported('seq must be a non-negative safe integer');
    }
    return seq;
}
export function sessionEventAt(session, seq) {
    if (!Number.isSafeInteger(seq) || seq < 0)
        unsupported('event position must be a non-negative safe integer');
    const access = session;
    let event;
    if (access.eventAt !== undefined) {
        if (typeof access.eventAt !== 'function')
            unsupported('eventAt must be a function');
        event = access.eventAt.call(session, seq);
    }
    else {
        event = legacyEvents(access)[seq];
    }
    if (event === undefined)
        return undefined;
    if (event === null || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string') {
        unsupported('eventAt must return an event object or undefined');
    }
    return event;
}
/** Check required capabilities before activation starts writing research records. */
export function assertSessionEventAccess(session) {
    sessionEvents(session);
    sessionEventAt(session, sessionNextSeq(session));
}
//# sourceMappingURL=session-events.js.map