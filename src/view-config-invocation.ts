/** Shared browser-safe descriptor for the always-available Root configuration projection. */
import { researchViewClientConfigSchema } from './wire.ts'

export const viewConfigInvocation = {
  id: 'dsh-profile-researcher#researcher/getViewConfig',
  service: 'researcher',
  namespace: 'researcher',
  method: 'getViewConfig',
  invocation: { kind: 'direct' as const },
  parameters: [],
  cancellation: { parameter: 'signal' as const },
  result: {
    mode: 'strict' as const,
    typeSymbol: 'dsh-profile-researcher/client-types#ResearchViewClientConfig',
    schema: researchViewClientConfigSchema,
  },
}
