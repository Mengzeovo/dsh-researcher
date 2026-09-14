/** Shared descriptors keep the Host and browser view codecs identical. */
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { researchViewChangedSchema, researchViewDetailSchema, researchViewNodeRequestSchema, researchViewRenderedSchema, researchViewRenderRequestSchema, researchViewRequestSchema, researchViewResponseSchema, researchViewWatchRequestSchema } from './view-wire.ts'

export const viewInvocations: readonly InvocationDescriptor[] = [
  { method: 'getView', input: researchViewRequestSchema, output: researchViewResponseSchema, request: 'ResearchViewRequest', response: 'ResearchViewResponse' },
  { method: 'getViewNode', input: researchViewNodeRequestSchema, output: researchViewDetailSchema, request: 'ResearchViewNodeRequest', response: 'ResearchViewNodeDetail' },
  { method: 'renderView', input: researchViewRenderRequestSchema, output: researchViewRenderedSchema, request: 'ResearchViewRenderRequest', response: 'ResearchViewRendered' },
  { method: 'watchView', input: researchViewWatchRequestSchema, output: researchViewChangedSchema, request: 'ResearchViewWatchRequest', response: 'ResearchViewChanged', stream: true },
].map(value => ({
  id: 'dsh-profile-researcher#researchView/' + value.method,
  service: 'researchView', namespace: 'researchView', method: value.method,
  invocation: { kind: 'direct' as const }, ...(value.stream ? { mode: 'stream' as const } : {}),
  parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: { mode: 'strict' as const, typeSymbol: 'dsh-profile-researcher/client-types#' + value.request, schema: value.input } }],
  cancellation: { parameter: 'signal' as const },
  result: { mode: 'strict' as const, typeSymbol: 'dsh-profile-researcher/client-types#' + value.response, schema: value.output },
}))
