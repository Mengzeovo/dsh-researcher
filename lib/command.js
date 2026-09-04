import { ResearcherError } from "./errors.js";
import { parseResearchId } from "./schema.js";
export const name = 'command-researcher';
export const inject = ['commands', 'researcher'];
export function apply(ctx) {
    ctx.commands.register({
        name: 'research-load',
        description: 'load and resume a project research target by research id',
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
                    sourceEventSeq: result.eventSeq,
                    text: [
                        `Research target loaded: ${result.researchId}`,
                        `Status: ${result.target.state.status}`,
                        `Goal action: ${result.goalAction}`,
                        `Authority: ${result.target.root}`,
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
}
//# sourceMappingURL=command.js.map