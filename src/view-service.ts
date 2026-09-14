/** Read-only research view BFF; the native plugin owns rendering and browser embedding. */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from 'dsh-archify-native/types'
import type {} from './index.ts'
import { ResearcherError } from './errors.ts'
import { researchViewConfigSchema } from './view-config.ts'
import { projectResearchView, type ResearchViewProjection } from './view-projection.ts'
import { researchWorkflow } from './view-workflow.ts'
import type { ResearchId } from './types.ts'
import type { ResearchReadContext, ResearchViewArtifactId, ResearchViewChanged, ResearchViewConfig, ResearchViewNodeDetail, ResearchViewNodeRequest, ResearchViewRendered, ResearchViewRenderRequest, ResearchViewRequest, ResearchViewResponse, ResearchViewSnapshotId, ResearchViewTargetToken, ResearchViewWatchRequest } from './view-types.ts'

interface ViewScope extends ResearchReadContext { readonly researchId: ResearchId | null; readonly targetToken: ResearchViewTargetToken }
interface CachedView { readonly scope: ViewScope; readonly recordVersion: string; readonly projection: ResearchViewProjection; readonly artifacts: Map<string, ResearchViewRendered>; readonly lifetime: AbortController }

declare module '@deepseek-ai/cordis' { interface Context { researchView: ResearchViewService } }

/** Activated explicitly by researcher view.enabled; never creates or resumes an Agent or Goal. */
export class ResearchViewService extends TypertRemoteService {
  static inject = ['researcher', 'archify', 'sessionQuery']
  static Config = researchViewConfigSchema
  private readonly cache = new Map<ResearchViewSnapshotId, CachedView>()
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly salt = randomBytes(32)

  constructor(ctx: Context, private readonly config: ResearchViewConfig) {
    super(ctx, 'researchView')
    if (!config.enabled) throw new ResearcherError('research view is not enabled', 'RESEARCH_VIEW_UNAVAILABLE')
    ctx.on('researcher/changed', ({ workspaceRoot, researchId }) => {
      for (const [key, entry] of this.cache) {
        if (entry.scope.workspaceRoot === workspaceRoot && entry.scope.researchId === researchId) this.evict(key)
      }
    })
    ctx.effect(() => async () => {
      this.lifetime.abort(new ResearcherError('research view service was disposed', 'RESEARCH_VIEW_UNAVAILABLE'))
      for (const key of this.cache.keys()) this.evict(key)
      await Promise.allSettled(this.pending)
    })
  }

  /** @param request - Session identity and optional page selection. @param signal - Cancels this read. @returns One bounded graph page or an unchanged/unbound marker. */
  getView(request: ResearchViewRequest, signal?: AbortSignal): Promise<ResearchViewResponse> {
    return this.execute(signal, async active => {
      const scope = await this.scope(request.sessionId, active)
      if (scope.researchId === null) return { kind: 'unbound' }
      const data = await this.ctx.researcher.viewData(scope, scope.researchId, this.config, active)
      active.throwIfAborted()
      const projection = projectResearchView(data, scope.targetToken, request, this.config)
      const key = projection.snapshot.snapshotId
      let entry = this.cache.get(key)
      if (entry === undefined) entry = { scope, recordVersion: data.recordVersion, projection, artifacts: new Map(), lifetime: new AbortController() }
      else this.cache.delete(key)
      this.cache.set(key, entry)
      while (this.cache.size > this.config.cacheEntries) this.evict(this.cache.keys().next().value!)
      return request.ifNoneMatch === key ? { kind: 'unchanged', snapshotId: key } : projection.snapshot
    })
  }

  /** @param request - Node on a cached page belonging to this Session's bound target. @param signal - Cancels this read. @returns The verified plan document or raw Run JSON. */
  getViewNode(request: ResearchViewNodeRequest, signal?: AbortSignal): Promise<ResearchViewNodeDetail> {
    return this.execute(signal, async active => {
      const entry = await this.current(request, active)
      const detail = entry.projection.details.get(request.nodeId)
      if (detail === undefined) throw new ResearcherError('node is not present on this research view page', 'RESEARCH_NOT_FOUND')
      this.assertSize(detail, this.config.maxDetailBytes, 'research view detail')
      return detail
    })
  }

  /** @param request - Cached page identity, theme, and diagram language. @param signal - Cancels the native render. @returns A versioned artifact, not a workspace file or authority record. */
  renderView(request: ResearchViewRenderRequest, signal?: AbortSignal): Promise<ResearchViewRendered> {
    return this.execute(signal, async active => {
      const entry = await this.current(request, active)
      if (entry.projection.snapshot.nodes.length === 0) throw new ResearcherError('an empty research view has no diagram', 'RESEARCH_VIEW_PAGE')
      const key = request.theme + ':' + request.locale
      const cached = entry.artifacts.get(key)
      if (cached !== undefined) return cached
      const renderSignal = AbortSignal.any([active, entry.lifetime.signal])
      let artifact: Awaited<ReturnType<Context['archify']['renderWorkflow']>>
      try { artifact = await this.ctx.archify.renderWorkflow({ spec: researchWorkflow(entry.projection.snapshot, request.locale), theme: request.theme, locale: request.locale }, renderSignal) }
      catch (error) {
        renderSignal.throwIfAborted()
        throw new ResearcherError(error instanceof Error ? error.message : String(error), 'RESEARCH_VIEW_UNAVAILABLE', { cause: error })
      }
      renderSignal.throwIfAborted()
      if (await this.current(request, renderSignal) !== entry) throw this.stale()
      const revision = createHash('sha256').update(JSON.stringify([request.snapshotId, artifact.specSha256, artifact.engineFingerprint, request.theme, request.locale])).digest('hex') as ResearchViewArtifactId
      const rendered = { ...artifact, revision }
      this.assertSize(rendered, this.config.maxRenderBytes, 'research view artifact')
      entry.artifacts.set(key, rendered)
      return rendered
    })
  }

  /** @param request - Observed Session identity. @param signal - Ends the subscription. @returns Coalesced invalidation hints; the first item closes the read/subscribe race. */
  async *watchView(request: ResearchViewWatchRequest, signal?: AbortSignal): AsyncIterable<ResearchViewChanged> {
    const active = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    const scope = await this.execute(active, current => this.scope(request.sessionId, current))
    let pending: ResearchViewChanged | undefined = { targetToken: scope.targetToken }
    let wake: (() => void) | undefined
    const dispose = this.ctx.on('researcher/changed', ({ workspaceRoot, researchId }) => {
      if (workspaceRoot !== scope.workspaceRoot || (scope.researchId !== null && researchId !== scope.researchId)) return
      pending = { targetToken: this.targetToken(workspaceRoot, researchId) }
      wake?.(); wake = undefined
    })
    const abort = (): void => { wake?.(); wake = undefined }
    active.addEventListener('abort', abort, { once: true })
    try {
      for (;;) {
        active.throwIfAborted()
        if (pending === undefined) await new Promise<void>(resolve => { wake = resolve })
        active.throwIfAborted()
        const next = pending; pending = undefined
        if (next !== undefined) yield next
      }
    } finally {
      active.removeEventListener('abort', abort)
      dispose()
    }
  }

  private async scope(sessionId: string, signal: AbortSignal): Promise<ViewScope> {
    signal.throwIfAborted()
    const observation = await this.ctx.sessionQuery.observeSession(SessionId(sessionId), { projectionMode: 'all', signal })
    try {
      const cwd = observation.header.cwd
      if (cwd === undefined) throw new ResearcherError('observed Session has no workspace', 'RESEARCH_PATH_INVALID')
      const projection = observation.projections?.values.researcherBinding
      if (projection === undefined) throw new ResearcherError('research binding projection is unavailable on the observed Session', 'RESEARCH_VIEW_UNAVAILABLE')
      if (projection.failure !== null) throw new ResearcherError(projection.failure, 'RESEARCH_INVALID_RECORD')
      const workspaceRoot = await this.ctx.researcher.viewWorkspace({ workspaceRoot: cwd })
      signal.throwIfAborted()
      const researchId = projection.binding?.researchId ?? null
      return { workspaceRoot, researchId, targetToken: this.targetToken(workspaceRoot, researchId) }
    } finally { observation[Symbol.dispose]() }
  }

  private async current(request: { readonly sessionId: string; readonly snapshotId: ResearchViewSnapshotId }, signal: AbortSignal): Promise<CachedView> {
    const scope = await this.scope(request.sessionId, signal)
    const entry = this.cache.get(request.snapshotId)
    if (entry === undefined || scope.researchId === null || entry.scope.targetToken !== scope.targetToken) throw this.stale()
    const data = await this.ctx.researcher.viewData(scope, scope.researchId, this.config, signal)
    signal.throwIfAborted()
    if (this.cache.get(request.snapshotId) !== entry || data.recordVersion !== entry.recordVersion) {
      this.evict(request.snapshotId)
      throw this.stale()
    }
    return entry
  }
  private targetToken(workspaceRoot: string, id: ResearchId | null): ResearchViewTargetToken {
    return createHmac('sha256', this.salt).update(JSON.stringify([workspaceRoot, id])).digest('hex') as ResearchViewTargetToken
  }
  private stale(): ResearcherError { return new ResearcherError('research view snapshot is stale; refresh this page', 'RESEARCH_VIEW_STALE') }
  private evict(key: ResearchViewSnapshotId): void {
    this.cache.get(key)?.lifetime.abort(this.stale())
    this.cache.delete(key)
  }
  private assertSize(value: unknown, limit: number, name: string): void {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > limit) throw new ResearcherError(name + ' exceeds its configured response byte limit', 'RESEARCH_OVERSIZED')
  }
  private execute<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const active = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    const task = Promise.resolve().then(async () => {
      try {
        active.throwIfAborted()
        const value = await operation(active)
        active.throwIfAborted()
        return value
      } catch (error) {
        if (error instanceof ResearcherError) throw new RemoteError('researcher/domain', error.message, { code: error.code }, { cause: error })
        throw error
      }
    })
    this.pending.add(task)
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task))
    return task
  }
}
export default ResearchViewService
