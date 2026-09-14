import { researchViewChangedSchema, researchViewDetailSchema, researchViewNodeRequestSchema, researchViewRenderedSchema, researchViewRenderRequestSchema, researchViewRequestSchema, researchViewResponseSchema, researchViewWatchRequestSchema } from "./view-wire.js";
export const viewInvocations = [
    { method: 'getView', input: researchViewRequestSchema, output: researchViewResponseSchema, request: 'ResearchViewRequest', response: 'ResearchViewResponse' },
    { method: 'getViewNode', input: researchViewNodeRequestSchema, output: researchViewDetailSchema, request: 'ResearchViewNodeRequest', response: 'ResearchViewNodeDetail' },
    { method: 'renderView', input: researchViewRenderRequestSchema, output: researchViewRenderedSchema, request: 'ResearchViewRenderRequest', response: 'ResearchViewRendered' },
    { method: 'watchView', input: researchViewWatchRequestSchema, output: researchViewChangedSchema, request: 'ResearchViewWatchRequest', response: 'ResearchViewChanged', stream: true },
].map(value => ({
    id: 'dsh-profile-researcher#researchView/' + value.method,
    service: 'researchView', namespace: 'researchView', method: value.method,
    invocation: { kind: 'direct' }, ...(value.stream ? { mode: 'stream' } : {}),
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-profile-researcher/client-types#' + value.request, schema: value.input } }],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: 'dsh-profile-researcher/client-types#' + value.response, schema: value.output },
}));
//# sourceMappingURL=view-invocations.js.map