/** Shared browser-safe descriptor for the always-available Root configuration projection. */
import { researchViewClientConfigSchema } from "./wire.js";
export const viewConfigInvocation = {
    id: 'dsh-profile-researcher#researcher/getViewConfig',
    service: 'researcher',
    namespace: 'researcher',
    method: 'getViewConfig',
    invocation: { kind: 'direct' },
    parameters: [],
    cancellation: { parameter: 'signal' },
    result: {
        mode: 'strict',
        typeSymbol: 'dsh-profile-researcher/client-types#ResearchViewClientConfig',
        schema: researchViewClientConfigSchema,
    },
};
//# sourceMappingURL=view-config-invocation.js.map