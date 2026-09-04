import { HarnessError } from '@deepseek-ai/dsh-llm';
export class ResearcherError extends HarnessError {
    constructor(message, code, options) {
        super(message, code, options);
        this.code = code;
    }
}
export function invalidRecord(message, options) {
    throw new ResearcherError(message, 'RESEARCH_INVALID_RECORD', options);
}
//# sourceMappingURL=errors.js.map