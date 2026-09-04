import { researchTargetListRequestSchema, researchTargetListSchema } from "./wire.js";
const descriptor = {
    id: 'dsh-profile-researcher#researcher/list',
    service: 'researcher',
    namespace: 'researcher',
    method: 'list',
    invocation: { kind: 'direct' },
    parameters: [
        {
            name: 'request',
            wire: 'request',
            source: 'json',
            codec: {
                mode: 'strict',
                typeSymbol: 'dsh-profile-researcher/client-types#ResearchTargetListRequest',
                schema: researchTargetListRequestSchema,
            },
        },
    ],
    cancellation: { parameter: 'signal' },
    result: {
        mode: 'strict',
        typeSymbol: 'dsh-profile-researcher/client-types#ResearchTargetList',
        schema: researchTargetListSchema,
    },
};
export const TYPERT = {
    package: 'dsh-profile-researcher',
    face: 'host',
    schemas: [],
    invocations: [descriptor],
    model: {
        services: [
            {
                description: 'Project-scoped cross-session research target authority.',
                summary: 'Research target authority.',
                tags: [],
                key: 'researcher',
                exportName: 'ResearcherService',
                members: [
                    {
                        kind: 'method',
                        name: 'list',
                        signature: 'async list(request: ResearchTargetListRequest, signal?: AbortSignal): Promise<ResearchTargetList>',
                        summary: 'List research targets in one exact live session workspace.',
                    },
                ],
                types: [
                    {
                        name: 'ResearchTargetListRequest',
                        declaration: 'export interface ResearchTargetListRequest { readonly sessionId: string }',
                    },
                    {
                        name: 'ResearchTargetList',
                        declaration: 'export interface ResearchTargetList { readonly version: 1; readonly boundResearchId?: ResearchId; readonly targets: readonly ResearchTargetSummary[]; readonly invalid: readonly InvalidResearchTargetSummary[] }',
                    },
                ],
            },
        ],
        events: [],
        objects: [],
    },
};
export default TYPERT;
//# sourceMappingURL=typert.host.js.map