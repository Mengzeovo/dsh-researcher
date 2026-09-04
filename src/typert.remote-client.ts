import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { researchTargetListRequestSchema, researchTargetListSchema } from './wire.ts'
import type { ResearchTargetList, ResearchTargetListRequest } from './types.ts'

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

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$72657365617263686572 {
    list: (request: ResearchTargetListRequest, signal?: AbortSignal) => Promise<RemoteResult<ResearchTargetList>>
  }

  interface TypertRemoteMap {
    'researcher/list': (request: ResearchTargetListRequest, signal?: AbortSignal) => Promise<RemoteResult<ResearchTargetList>>
  }

  interface TypertRemoteNamespaceMap {
    researcher: TypertRemoteNamespace$72657365617263686572
  }
}

export const TYPERT_REMOTE = {
  package: 'dsh-profile-researcher',
  descriptors: [descriptor],
} satisfies TypertRemoteContribution

export default TYPERT_REMOTE
