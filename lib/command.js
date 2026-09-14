import { SessionSeq } from '@deepseek-ai/dsh-session/types';
import { ResearcherError } from "./errors.js";
import { renderResearchRecovery } from "./context.js";
import { parseResearchId } from "./schema.js";
export const name = 'command-researcher';
export const inject = ['commands', 'researcher'];
export function apply(ctx) {
    ctx.commands.register({
        name: 'research-load',
        description: 'load research background and give one status briefing without starting automatic work',
        input: { hint: '[<research-id>]' },
        recordInput: false,
        async handler(invocation) {
            if (invocation.attachments.length > 0) {
                return { kind: 'error', text: '/research-load does not accept image attachments.' };
            }
            const input = invocation.rawInput.trim();
            if (input.length === 0) {
                return {
                    kind: 'error',
                    text: 'A research id is required in this surface. Use /research-load <research-id>; the Web GUI opens a picker for the bare command.',
                };
            }
            if (/\s/u.test(input)) {
                return { kind: 'error', text: 'Usage: /research-load <research-id>' };
            }
            try {
                const id = parseResearchId(input);
                const result = await ctx.researcher.load(invocation.agent, id, invocation.signal);
                return {
                    kind: 'success',
                    sourceEventSeq: SessionSeq(result.eventSeq),
                    text: [
                        `Research target loaded: ${result.researchId}`,
                        `Status: ${result.target.state.status}`,
                        `Goal action: ${result.goalAction}`,
                        'Automatic advancement is OFF. One read-only context briefing is queued.',
                        'Discuss normally, or explicitly use /research-start to begin continuous advancement.',
                        `Authority: ${result.target.root}`,
                        ...(result.target.recovery === undefined ? [] : [renderResearchRecovery(result.target.recovery)]),
                        ...(result.target.warnings.length === 0 ? [] : [`Warnings: ${result.target.warnings.join('; ')}`]),
                    ].join('\n'),
                };
            }
            catch (error) {
                if (error instanceof ResearcherError)
                    return { kind: 'error', text: `${error.code}: ${error.message}` };
                throw error;
            }
        },
    });
    ctx.commands.register({
        name: 'research-start',
        description: 'explicitly start or resume automatic advancement of the loaded research target',
        recordInput: false,
        async handler(invocation) {
            if (invocation.rawInput.trim() !== '' || invocation.attachments.length > 0) {
                return { kind: 'error', text: 'Usage: /research-start (the current target must already be loaded; no attachments)' };
            }
            try {
                const result = await ctx.researcher.start(invocation.agent, invocation.signal);
                return {
                    kind: 'success',
                    text: [
                        `Research advancement started: ${result.researchId}`,
                        `Status: ${result.target.state.status}`,
                        `Goal action: ${result.goalAction}`,
                        'Automatic advancement is ON. Use /goal pause to stop subsequent rounds.',
                    ].join('\n'),
                };
            }
            catch (error) {
                if (error instanceof ResearcherError)
                    return { kind: 'error', text: `${error.code}: ${error.message}` };
                throw error;
            }
        },
    });
}
//# sourceMappingURL=command.js.map