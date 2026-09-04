import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { ResearchTargetList, ResearchTargetListRequest } from './types.ts';
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteNamespace$72657365617263686572 {
        list: (request: ResearchTargetListRequest, signal?: AbortSignal) => Promise<RemoteResult<ResearchTargetList>>;
    }
    interface TypertRemoteMap {
        'researcher/list': (request: ResearchTargetListRequest, signal?: AbortSignal) => Promise<RemoteResult<ResearchTargetList>>;
    }
    interface TypertRemoteNamespaceMap {
        researcher: TypertRemoteNamespace$72657365617263686572;
    }
}
export declare const TYPERT_REMOTE: {
    package: string;
    descriptors: {
        id: string;
        service: string;
        namespace: string;
        method: string;
        invocation: {
            kind: "direct";
        };
        parameters: {
            name: string;
            wire: string;
            source: "json";
            codec: {
                mode: "strict";
                typeSymbol: string;
                schema: import("zod").ZodType<ResearchTargetListRequest, unknown, import("zod/v4/core").$ZodTypeInternals<ResearchTargetListRequest, unknown>>;
            };
        }[];
        cancellation: {
            parameter: "signal";
        };
        result: {
            mode: "strict";
            typeSymbol: string;
            schema: import("zod").ZodType<ResearchTargetList, unknown, import("zod/v4/core").$ZodTypeInternals<ResearchTargetList, unknown>>;
        };
    }[];
};
export default TYPERT_REMOTE;
//# sourceMappingURL=typert.remote-client.d.ts.map