export declare const TYPERT: {
    package: string;
    face: "host";
    schemas: never[];
    invocations: {
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
                schema: import("zod").ZodType<import("./types.ts").ResearchTargetListRequest, unknown, import("zod/v4/core").$ZodTypeInternals<import("./types.ts").ResearchTargetListRequest, unknown>>;
            };
        }[];
        cancellation: {
            parameter: "signal";
        };
        result: {
            mode: "strict";
            typeSymbol: string;
            schema: import("zod").ZodType<import("./types.ts").ResearchTargetList, unknown, import("zod/v4/core").$ZodTypeInternals<import("./types.ts").ResearchTargetList, unknown>>;
        };
    }[];
    model: {
        services: {
            description: string;
            summary: string;
            tags: never[];
            key: string;
            exportName: string;
            members: {
                kind: "method";
                name: string;
                signature: string;
                summary: string;
            }[];
            types: {
                name: string;
                declaration: string;
            }[];
        }[];
        events: never[];
        objects: never[];
    };
};
export default TYPERT;
//# sourceMappingURL=typert.host.d.ts.map