/** Host researcher service: project-file authority, session binding, and Goal activation. */
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import { buildResearchContext, createResearchContextMessage, markerResearchId, researchBindingFromMessage, researchGoalObjective, } from "./context.js";
import { ResearcherError } from "./errors.js";
import { nowIso, parseResearchId, researchBindingSchema, researchTargetListRequestSchema } from "./schema.js";
import { ResearchStore } from "./storage.js";
const researcherBindingProjectionSchema = z.object({
    bindings: z.record(z.string(), researchBindingSchema).superRefine((bindings, ctx) => {
        for (const [sessionId, binding] of Object.entries(bindings)) {
            if (binding.sessionId !== sessionId) {
                ctx.addIssue({ code: 'custom', path: [sessionId], message: 'binding key does not match sessionId' });
            }
        }
    }),
    failure: z.string().min(1).nullable(),
}).strict();
export function applyResearcherBindingProjection(state, event) {
    if (state.failure !== null || event.type !== 'agent/inbox/spliced')
        return state;
    let next = state;
    for (const message of event.data.inserted) {
        let binding;
        try {
            binding = researchBindingFromMessage(message);
        }
        catch (error) {
            return {
                ...state,
                failure: `researcher binding replay failed at event ${event.seq}: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        if (binding === undefined)
            continue;
        const existing = next.bindings[binding.sessionId];
        if (existing !== undefined && existing.researchId !== binding.researchId) {
            return {
                ...state,
                failure: `researcher binding replay found conflicting ids ${existing.researchId} and ${binding.researchId} for session ${binding.sessionId} at event ${event.seq}`,
            };
        }
        next = {
            bindings: { ...next.bindings, [binding.sessionId]: binding },
            failure: null,
        };
    }
    return next;
}
export const researcherBindingProjectionDefinition = {
    key: 'researcherBinding',
    stateVersion: 1,
    stateSchema: researcherBindingProjectionSchema,
    init: () => ({ bindings: {}, failure: null }),
    apply: applyResearcherBindingProjection,
};
function goalRef(goal) {
    return { id: goal.id, revision: goal.revision };
}
function goalMarkerMatches(goal, id) {
    return markerResearchId(goal.objective) === id;
}
class SerialGate {
    tail = Promise.resolve();
    async run(operation) {
        const previous = this.tail;
        let release;
        this.tail = new Promise(resolve => { release = resolve; });
        await previous;
        try {
            return await operation();
        }
        finally {
            release();
        }
    }
}
export class ResearcherService extends TypertRemoteService {
    static inject = ['agents', 'fs', 'goals', 'sandboxPolicy', 'sessionProjections'];
    store;
    activationGates = new WeakMap();
    constructor(ctx) {
        super(ctx, 'researcher');
        this.store = new ResearchStore(ctx);
        ctx.sessionProjections.register(researcherBindingProjectionDefinition);
    }
    binding(session) {
        const state = this.ctx.sessionProjections.stateOf(session, 'researcherBinding');
        if (state === undefined)
            throw new ResearcherError('researcher binding projection is not registered', 'RESEARCH_INVALID_RECORD');
        if (state.failure !== null)
            throw new ResearcherError(state.failure, 'RESEARCH_INVALID_RECORD');
        return state.bindings[String(session.id)];
    }
    async list(request, signal) {
        const parsed = researchTargetListRequestSchema.parse(request);
        try {
            const agent = this.ctx.agents.get(SessionId(parsed.sessionId));
            if (agent === undefined) {
                throw new ResearcherError(`session ${parsed.sessionId} is not a live agent`, 'RESEARCH_SESSION_NOT_LIVE');
            }
            const listed = await this.store.listTargets(agent.session, signal);
            const binding = this.binding(agent.session);
            return {
                version: 1,
                ...(binding === undefined ? {} : { boundResearchId: binding.researchId }),
                targets: listed.targets,
                invalid: listed.invalid,
            };
        }
        catch (error) {
            if (error instanceof ResearcherError) {
                throw new RemoteError('researcher/domain', error.message, { code: error.code }, { cause: error });
            }
            throw error;
        }
    }
    async get(agent, signal) {
        const binding = this.requireBinding(agent.session);
        const target = await this.store.readTarget(agent.session, binding.researchId, signal);
        return {
            researchId: binding.researchId,
            target,
            context: buildResearchContext(target, binding),
        };
    }
    async create(agent, request, signal) {
        return await this.activationGate(agent.session).run(async () => {
            this.assertCreateCompatible(agent);
            const target = await this.store.createTarget(agent.session, request, signal);
            try {
                const loaded = await this.activate(agent, target, signal);
                return { ...loaded, created: true };
            }
            catch (error) {
                throw new ResearcherError(`research target ${target.id} was committed but activation failed; recover with /research-load ${target.id}`, error instanceof ResearcherError ? error.code : 'RESEARCH_GOAL_CONFLICT', { cause: error });
            }
        });
    }
    async load(agent, idInput, signal) {
        const id = typeof idInput === 'string' ? parseResearchId(idInput) : idInput;
        return await this.activationGate(agent.session).run(async () => {
            this.assertBindingCompatible(agent.session, id);
            const target = await this.store.readTarget(agent.session, id, signal);
            return await this.activate(agent, target, signal);
        });
    }
    async updateState(agent, request, signal) {
        const binding = this.requireBinding(agent.session);
        return await this.store.appendState(agent.session, binding.researchId, request, signal);
    }
    async startRun(agent, request, signal) {
        const binding = this.requireBinding(agent.session);
        return await this.store.startRun(agent.session, binding.researchId, request, signal);
    }
    async finishRun(agent, request, signal) {
        const binding = this.requireBinding(agent.session);
        return await this.store.finishRun(agent.session, binding.researchId, request, signal);
    }
    async updateGlossary(agent, patch, signal) {
        const binding = this.requireBinding(agent.session);
        return await this.store.updateGlossary(agent.session, binding.researchId, patch, signal);
    }
    async activate(agent, initialTarget, signal) {
        this.assertBindingCompatible(agent.session, initialTarget.id);
        this.assertGoalCompatible(agent, initialTarget.id);
        this.assertGoalActivationCapacity(agent, initialTarget);
        const target = initialTarget.state.status === 'paused' || initialTarget.state.status === 'blocked'
            ? await this.store.resumeState(agent.session, initialTarget.id, signal)
            : initialTarget;
        const loadedAt = nowIso();
        const binding = researchBindingSchema.parse({
            version: 1,
            researchId: target.id,
            sessionId: String(agent.session.id),
            loadedAt,
        });
        const context = buildResearchContext(target, binding);
        const message = createResearchContextMessage(context);
        await this.store.bindSession(agent.session, target.id, loadedAt, signal);
        const eventSeq = agent.session.events.length;
        agent.inject(message);
        const event = agent.session.events[eventSeq];
        if (event?.type !== 'agent/inbox/spliced'
            || !event.data.inserted.some(inserted => researchBindingFromMessage(inserted)?.researchId === target.id)) {
            throw new ResearcherError('researcher context injection did not produce the expected durable inbox event', 'RESEARCH_INVALID_RECORD');
        }
        let goalAction;
        try {
            goalAction = this.applyGoalActivation(agent, target);
        }
        catch (error) {
            throw new ResearcherError(`research target ${target.id} was loaded and injected, but its DSH Goal could not be activated; retry /research-load ${target.id}`, 'RESEARCH_GOAL_CONFLICT', { cause: error });
        }
        return { researchId: target.id, eventSeq: event.seq, target, context, goalAction };
    }
    assertCreateCompatible(agent) {
        if (this.binding(agent.session) !== undefined) {
            throw new ResearcherError('this DSH session is already bound to a research target', 'RESEARCH_SESSION_BOUND');
        }
        const goal = this.ctx.goals.get(agent);
        if (goal !== undefined && goal.phase !== 'complete') {
            throw new ResearcherError('an unfinished DSH Goal already owns this session; complete or clear it before creating a research target', 'RESEARCH_GOAL_CONFLICT');
        }
    }
    assertBindingCompatible(session, id) {
        const binding = this.binding(session);
        if (binding !== undefined && binding.researchId !== id) {
            throw new ResearcherError(`this DSH session is already bound to research target ${binding.researchId}`, 'RESEARCH_SESSION_BOUND');
        }
    }
    assertGoalCompatible(agent, id) {
        const goal = this.ctx.goals.get(agent);
        if (goal === undefined || goal.phase === 'complete' || goalMarkerMatches(goal, id))
            return;
        throw new ResearcherError('a different unfinished DSH Goal already owns this session; researcher will not replace it silently', 'RESEARCH_GOAL_CONFLICT');
    }
    assertGoalActivationCapacity(agent, target) {
        if (target.state.status === 'complete')
            return;
        const goal = this.ctx.goals.get(agent);
        if (goal === undefined || goal.phase === 'complete')
            return;
        const needsResume = goal.phase !== 'active' || goal.activation !== 'armed';
        if (needsResume && goal.roundsStarted >= goal.maxGoalRounds) {
            throw new ResearcherError(`DSH Goal ${goal.id} exhausted its ${goal.maxGoalRounds} automatic rounds before researcher activation`, 'RESEARCH_GOAL_CONFLICT');
        }
    }
    activationGate(session) {
        const existing = this.activationGates.get(session);
        if (existing !== undefined)
            return existing;
        const created = new SerialGate();
        this.activationGates.set(session, created);
        return created;
    }
    applyGoalActivation(agent, target) {
        const current = this.ctx.goals.get(agent);
        if (target.state.status === 'complete') {
            if (current !== undefined && current.phase !== 'complete' && goalMarkerMatches(current, target.id)) {
                this.ctx.goals.complete(agent, goalRef(current));
                return 'completed';
            }
            return 'view-only';
        }
        const objective = researchGoalObjective(target);
        if (current === undefined || current.phase === 'complete') {
            this.ctx.goals.create(agent, { objective });
            return 'created';
        }
        if (!goalMarkerMatches(current, target.id)) {
            throw new ResearcherError('current DSH Goal marker does not match the loaded target', 'RESEARCH_GOAL_CONFLICT');
        }
        let latest = current;
        let edited = false;
        if (latest.objective !== objective) {
            latest = this.ctx.goals.edit(agent, goalRef(latest), { objective });
            edited = true;
        }
        if (latest.phase !== 'active' || latest.activation !== 'armed') {
            this.ctx.goals.resume(agent, goalRef(latest));
            return 'resumed';
        }
        return edited ? 'updated' : 'unchanged';
    }
    requireBinding(session) {
        const binding = this.binding(session);
        if (binding === undefined) {
            throw new ResearcherError('no research target is loaded in this DSH session', 'RESEARCH_NOT_FOUND');
        }
        return binding;
    }
}
export const name = 'researcher';
export const inject = ResearcherService.inject;
export default ResearcherService;
export { ResearcherError } from "./errors.js";
//# sourceMappingURL=index.js.map