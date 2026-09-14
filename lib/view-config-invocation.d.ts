export declare const viewConfigInvocation: {
    id: string;
    service: string;
    namespace: string;
    method: string;
    invocation: {
        kind: "direct";
    };
    parameters: never[];
    cancellation: {
        parameter: "signal";
    };
    result: {
        mode: "strict";
        typeSymbol: string;
        schema: import("zod").ZodType<import("./types.ts").ResearchViewClientConfig, unknown, import("zod/v4/core").$ZodTypeInternals<import("./types.ts").ResearchViewClientConfig, unknown>>;
    };
};
//# sourceMappingURL=view-config-invocation.d.ts.map