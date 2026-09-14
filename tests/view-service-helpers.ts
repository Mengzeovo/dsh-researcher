import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { onTestFinished, vi } from 'vitest'
import type { ArchifyRenderRequest, ArchifyRenderResult } from 'dsh-archify-native/types'
import { ResearchViewService } from '../src/view-service.ts'
import type { ResearchId } from '../src/types.ts'
import type { ResearchViewConfig, ResearchViewResponse, ResearchViewSnapshot } from '../src/view-types.ts'
import { viewConfig, viewFixture } from './view-test-helpers.ts'

export function ready(response: ResearchViewResponse): ResearchViewSnapshot {
  if (response.kind !== 'ready' && response.kind !== 'empty') throw new Error('expected graph response')
  return response
}
export const domainError = (code: string) => ({ code: 'researcher/domain', details: { code } })
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export function rendered(request: ArchifyRenderRequest, engine = 'e'.repeat(64)): ArchifyRenderResult {
  return { html: '<!DOCTYPE html><html>研究</html>', svg: '<svg xmlns="http://www.w3.org/2000/svg">研究</svg>', specSha256: createHash('sha256').update(JSON.stringify(request.spec)).digest('hex'), engineFingerprint: engine, nodeIds: (request.spec.nodes as readonly { id: string }[]).map(node => node.id) }
}
interface ObservationInput { cwd?: string; researchId: ResearchId | null; failure?: string | null; mode?: 'cold' | 'prepared'; projection?: boolean }
export async function serviceFixture(config: Partial<ResearchViewConfig> = {}) {
  const f = await viewFixture()
  const workspaceRoot = await realpath(f.root)
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const observations = new Map<string, ObservationInput>([['view/test', { cwd: workspaceRoot, researchId: f.target.id }]])
  const leases: ReturnType<typeof vi.fn>[] = []
  const observeSession = vi.fn(async (id: string, options: { projectionMode?: string; signal?: AbortSignal }) => {
    options.signal?.throwIfAborted()
    const value = observations.get(id)
    if (value === undefined) throw new Error('unknown test session')
    const dispose = vi.fn(); leases.push(dispose)
    return { kind: value.mode ?? 'cold', header: { id, ...(value.cwd === undefined ? {} : { cwd: value.cwd }) },
      ...(value.projection === false ? {} : { projections: { values: { researcherBinding: { binding: value.researchId === null ? null : { researchId: value.researchId }, failure: value.failure ?? null } } } }),
      get events(): never { throw new Error('view must use projection, not events') }, [Symbol.dispose]: dispose }
  })
  const viewWorkspace = vi.fn(async ({ workspaceRoot }: { workspaceRoot: string }) => realpath(workspaceRoot))
  const viewData = vi.fn(async (scope: { workspaceRoot: string }, id: ResearchId, limits: ResearchViewConfig, signal?: AbortSignal) => {
    if (scope.workspaceRoot !== workspaceRoot || id !== f.target.id) throw new Error('unexpected data scope')
    return f.read(limits, signal)
  })
  const renderWorkflow = vi.fn(async (request: ArchifyRenderRequest, _signal?: AbortSignal) => rendered(request))
  // These unit providers implement only the injected methods exercised by the BFF.
  ctx.provide('researcher', { viewWorkspace, viewData } as unknown as Context['researcher'])
  ctx.provide('sessionQuery', { observeSession } as unknown as Context['sessionQuery'])
  ctx.provide('archify', { renderWorkflow })
  const fiber = ctx.plugin(ResearchViewService, { ...viewConfig, ...config }); await fiber
  return { ...f, root: workspaceRoot, context: ctx, fiber, service: ctx.researchView, observations, leases, observeSession, viewWorkspace, viewData, renderWorkflow }
}
