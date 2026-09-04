import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { researchTargetListRequestSchema, researchTargetListSchema } from './wire.ts'

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
} satisfies TypertContribution

export default TYPERT
