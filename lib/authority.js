import { markerResearchId } from "./context.js";
import { ResearcherError } from "./errors.js";
import { sessionEvents } from "./session-events.js";
function reject(message, code) {
    throw new ResearcherError(message, code);
}
function openTurnEvents(ctx, agent) {
    const events = sessionEvents(agent.session);
    const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary');
    if (boundary === undefined || boundary.openTurnStartSeq === null) {
        reject('researcher tools require an open model turn', 'RESEARCH_DRIVER_REQUIRED');
    }
    return { events, openTurnStartSeq: boundary.openTurnStartSeq };
}
export function researchToolExecution(ctx, exec) {
    const agent = exec.agent;
    if (agent === undefined)
        reject('researcher tools require a calling agent', 'RESEARCH_DRIVER_REQUIRED');
    if (ctx.agents.get(agent.id) !== agent
        || agent.status !== 'running'
        || ctx.agents.currentInitiator() !== agent) {
        reject('researcher tools require the exact live calling agent inside its active driver', 'RESEARCH_DRIVER_REQUIRED');
    }
    return { agent, ...openTurnEvents(ctx, agent) };
}
function someOpenTurnEvent(execution, predicate) {
    for (let seq = execution.openTurnStartSeq + 1; seq < execution.events.length; seq += 1) {
        const event = execution.events[seq];
        if (event !== undefined && predicate(event))
            return true;
    }
    return false;
}
function hasDirectHumanInput(ctx, execution) {
    if (!ctx.agents.roots().includes(execution.agent))
        return false;
    return someOpenTurnEvent(execution, event => event.type === 'user/message' && event.data.source.kind === 'user');
}
function isMatchingGoalRound(execution, goal, id) {
    if (markerResearchId(goal.objective) !== id)
        return false;
    return someOpenTurnEvent(execution, event => event.type === 'user/message'
        && event.data.source.kind === 'goal'
        && event.data.source.goalId === goal.id
        && event.data.source.revision === goal.revision
        && event.data.source.round === goal.roundsStarted);
}
export function requireDirectHuman(ctx, execution) {
    if (hasDirectHumanInput(ctx, execution))
        return;
    reject('creating a research target requires a direct human turn on a top-level agent', 'RESEARCH_AUTHORITY_REQUIRED');
}
export function requireResearchMutation(ctx, execution, id) {
    if (hasDirectHumanInput(ctx, execution))
        return;
    const goal = ctx.goals.get(execution.agent);
    if (goal !== undefined && isMatchingGoalRound(execution, goal, id))
        return;
    reject('research mutations require a direct human turn or the exact current Goal Round for the loaded research target', 'RESEARCH_AUTHORITY_REQUIRED');
}
//# sourceMappingURL=authority.js.map