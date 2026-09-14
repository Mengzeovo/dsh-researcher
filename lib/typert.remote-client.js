import { researchTargetListRequestSchema, researchTargetListSchema } from "./wire.js";
import { viewConfigInvocation } from "./view-config-invocation.js";
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
export const TYPERT_REMOTE = {
    package: 'dsh-profile-researcher',
    descriptors: [descriptor, viewConfigInvocation],
};
export default TYPERT_REMOTE;
//# sourceMappingURL=typert.remote-client.js.map