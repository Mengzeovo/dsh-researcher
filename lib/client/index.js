/** Web decoration for bare /research-load using the DSH-owned popupSelect shell. */
import viewRemote from "../view-remote-client.js";
import { installResearchView, VIEW_INJECT } from "./view-apply.js";
import researcherRemote from "../typert.remote-client.js";
export const inject = ['remote'];
const UI_INJECT = ['commandUi', 'sessions', 'remote', 'remote.researcher'];
const INVALID_PREFIX = 'invalid:';
// Typert owns one registration per package, including all its Remote namespaces.
const clientRemote = {
    package: researcherRemote.package,
    descriptors: [...researcherRemote.descriptors, ...viewRemote.descriptors],
};
export function researchOptions(list) {
    const valid = list.targets.map(target => ({
        id: target.id,
        label: target.description,
        detail: `${target.id} · ${target.status}${target.warningCount === 0 ? '' : ` · ⚠ ${target.warningCount}`}`,
        ...(target.id === list.boundResearchId ? { active: true } : {}),
    }));
    const invalid = list.invalid.map(target => ({
        id: `${INVALID_PREFIX}${target.id}`,
        label: `Invalid research target: ${target.id}`,
        detail: `${target.id} · ${target.code} · ${target.detail}`,
    }));
    return [...valid, ...invalid];
}
function installResearchUi(ctx) {
    const command = ctx.get('commandUi');
    const sessions = ctx.get('sessions');
    return command.decorate({
        name: 'research-load',
        available: session => sessions.binding(session.sessionId)?.session !== undefined,
        ui: {
            kind: 'popupSelect',
            options: async (session, signal) => {
                const live = sessions.binding(session.sessionId)?.session;
                if (live === undefined)
                    throw new Error('this session is not materialized yet');
                const result = await ctx.remote.researcher.list({ sessionId: String(session.sessionId) }, signal);
                if (!result.ok) {
                    const code = result.error.code === 'researcher/domain'
                        ? result.error.details.code
                        : result.error.code;
                    throw new Error(`research target listing failed: ${code}: ${result.error.message}`);
                }
                return researchOptions(result.value);
            },
            onSelect: async (option, session) => {
                if (option.id.startsWith(INVALID_PREFIX)) {
                    throw new Error('this research target is invalid; repair its project records before loading it');
                }
                const live = sessions.binding(session.sessionId)?.session;
                if (live === undefined)
                    throw new Error('this session is not materialized yet');
                const result = await live.command(`/research-load ${option.id}`);
                if (!result.ok)
                    throw new Error(`research load failed: ${result.error.code}: ${result.error.message}`);
                if (!result.value.matched)
                    throw new Error('the host offers no /research-load command in this agent preset');
            },
        },
    });
}
/** Fetch the Host's public settings before installing optional view services. */
export async function apply(ctx) {
    const lifecycle = new AbortController();
    ctx.effect(() => () => lifecycle.abort(), 'researcher: configuration handshake');
    // A pending async plugin cannot drain its effects until startup settles.
    ctx.on('internal/plugin', fiber => {
        if (fiber === ctx.fiber && fiber.uid === null)
            lifecycle.abort();
    });
    let disposeRemote;
    let uiFiber;
    let viewFiber;
    const dispose = async () => {
        lifecycle.abort();
        try {
            await viewFiber?.dispose();
        }
        finally {
            try {
                await uiFiber?.dispose();
            }
            finally {
                await disposeRemote?.();
            }
        }
    };
    try {
        disposeRemote = await ctx.remote.$mount(clientRemote);
        lifecycle.signal.throwIfAborted();
        const researcher = ctx.get('remote.researcher');
        if (researcher === undefined)
            throw new Error('researcher configuration namespace did not mount');
        const result = await researcher.getViewConfig(lifecycle.signal);
        lifecycle.signal.throwIfAborted();
        if (!result.ok)
            throw new Error('researcher view configuration failed: ' + result.error.message);
        // A non-constructible callback lets Cordis collect the returned picker disposer.
        uiFiber = ctx.inject(UI_INJECT, uiCtx => installResearchUi(uiCtx));
        if (result.value.enabled) {
            viewFiber = ctx.inject(VIEW_INJECT, viewCtx => installResearchView(viewCtx, result.value.presetIds));
        }
        await uiFiber;
        await viewFiber;
        lifecycle.signal.throwIfAborted();
        return dispose;
    }
    catch (error) {
        await dispose();
        throw error;
    }
}
//# sourceMappingURL=index.js.map