import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { researchTargetListRequestSchema, researchTargetListSchema } from './wire.ts'
import { viewInvocations } from './view-invocations.ts'

import { viewConfigInvocation } from './view-config-invocation.ts'

const descriptor = {
  id: 'dsh-profile-researcher#researcher/list',
  service: 'researcher',
  namespace: 'researcher',
  method: 'list',
  invocation: { kind: 'direct' as const },
  parameters: [
    {
      name: 'request',
      wire: 'request',
      source: 'json' as const,
      codec: {
        mode: 'strict' as const,
        typeSymbol: 'dsh-profile-researcher/client-types#ResearchTargetListRequest',
        schema: researchTargetListRequestSchema,
      },
    },
  ],
  cancellation: { parameter: 'signal' as const },
  result: {
    mode: 'strict' as const,
    typeSymbol: 'dsh-profile-researcher/client-types#ResearchTargetList',
    schema: researchTargetListSchema,
  },
}

export const TYPERT = {
  package: 'dsh-profile-researcher',
  face: 'host',
  schemas: [],
  invocations: [descriptor, viewConfigInvocation, ...viewInvocations],
  model: {
    services: [
      {
        description: 'Project-scoped cross-session research target authority.',
        summary: 'Research target authority.',
        tags: [],
        key: 'researcher',
        exportName: 'ResearcherService',
        members: [
          { kind: 'method', name: 'getViewConfig', signature: 'getViewConfig(signal?: AbortSignal): Promise<ResearchViewClientConfig>', summary: 'Read only enabled and presetIds from Host configuration without Session access.' },
          {
            kind: 'method',
            name: 'list',
            signature: 'async list(request: ResearchTargetListRequest, signal?: AbortSignal): Promise<ResearchTargetList>',
            summary: 'List research targets in one exact live session workspace.',
          },
        ],
        types: [
          { name: 'ResearchViewClientConfig', declaration: 'export interface ResearchViewClientConfig { readonly enabled: boolean; readonly presetIds: readonly string[] }' },
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
      {
        description: 'Optional read-only research view using cold Session observations and Native Archify.',
        summary: 'Research graph pages and native rendering.',
        tags: [], key: 'researchView', exportName: 'ResearchViewService',
        members: [
          { kind: 'method', name: 'getView', signature: 'getView(request: ResearchViewRequest, signal?: AbortSignal): Promise<ResearchViewResponse>', summary: 'Read a verified, bounded plan and experiment page.' },
          { kind: 'method', name: 'getViewNode', signature: 'getViewNode(request: ResearchViewNodeRequest, signal?: AbortSignal): Promise<ResearchViewNodeDetail>', summary: 'Read a node on a currently authorized snapshot.' },
          { kind: 'method', name: 'renderView', signature: 'renderView(request: ResearchViewRenderRequest, signal?: AbortSignal): Promise<ResearchViewRendered>', summary: 'Render a verified page using the native service.' },
          { kind: 'method', name: 'watchView', signature: 'watchView(request: ResearchViewWatchRequest, signal?: AbortSignal): AsyncIterable<ResearchViewChanged>', summary: 'Observe coalesced target invalidation hints.' },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
} satisfies TypertContribution

export default TYPERT
