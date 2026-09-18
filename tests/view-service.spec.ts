import { createHash } from 'node:crypto'
import type { ArchifyRenderResult } from 'dsh-archify-native/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseResearchId } from '../src/schema.ts'
import { planNodeId, runNodeId } from '../src/view-projection.ts'
import type { ResearchViewChanged } from '../src/view-types.ts'
import { deferred, domainError, ready, rendered, serviceFixture } from './view-service-helpers.ts'

afterEach(() => vi.restoreAllMocks())
const request = { sessionId: 'view/test' }
const theme = { theme: 'light' as const, locale: 'en' as const }

describe('research view BFF unit providers', () => {
  it('uses cold/prepared projection leases without events and releases all outcomes', async () => {
    const f = await serviceFixture()
    for (const mode of ['cold', 'prepared'] as const) {
      f.observations.set(request.sessionId, { cwd: f.root, researchId: f.target.id, mode })
      expect(ready(await f.service.getView(request)).nodes).toHaveLength(1)
    }
    f.observations.set(request.sessionId, { cwd: f.root, researchId: null })
    expect(await f.service.getView(request)).toEqual({ kind: 'unbound' })
    for (const [input, code] of [
      [{ researchId: f.target.id }, 'RESEARCH_PATH_INVALID'],
      [{ cwd: f.root, researchId: f.target.id, projection: false }, 'RESEARCH_VIEW_UNAVAILABLE'],
      [{ cwd: f.root, researchId: f.target.id, failure: 'bad binding event' }, 'RESEARCH_INVALID_RECORD'],
    ] as const) {
      f.observations.set(request.sessionId, input)
      await expect(f.service.getView(request)).rejects.toMatchObject(domainError(code))
    }
    expect(f.observeSession.mock.calls.every(([, options]) => options.projectionMode === 'all')).toBe(true)
    expect(f.leases).toHaveLength(6)
    expect(f.leases.every(lease => lease.mock.calls.length === 1)).toBe(true)
  })

  it('reuses project snapshots across bound Sessions but rejects different targets/workspaces and unbound consumers', async () => {
    const f = await serviceFixture()
    const snapshot = ready(await f.service.getView(request))
    expect(await f.service.getView({ ...request, ifNoneMatch: snapshot.snapshotId })).toEqual({ kind: 'unchanged', snapshotId: snapshot.snapshotId })
    const obsolete = { ...request, versionPage: 999, ifNoneMatch: snapshot.snapshotId }
    expect(await f.service.getView(obsolete)).toEqual({ kind: 'unchanged', snapshotId: snapshot.snapshotId })
    f.observations.set('other/session', { cwd: f.root, researchId: f.target.id })
    const node = { sessionId: 'other/session', snapshotId: snapshot.snapshotId, nodeId: snapshot.nodes[0]!.id }
    expect((await f.service.getViewNode(node)).kind).toBe('plan')
    for (const observation of [
      { cwd: f.root, researchId: null },
      { cwd: f.root, researchId: parseResearchId('123e4567-e89b-42d3-a456-426614174099') },
      { cwd: '/tmp', researchId: f.target.id },
    ]) {
      f.observations.set('other/session', observation)
      await expect(f.service.getViewNode(node)).rejects.toMatchObject(domainError('RESEARCH_VIEW_STALE'))
    }
    expect(f.leases.every(lease => lease.mock.calls.length === 1)).toBe(true)
  })

  it('rejects off-page nodes and changed authority before detail or rendering', async () => {
    const f = await serviceFixture({ runsPerVersionPage: 1 })
    await f.addVersion(1, 1)
    await f.addRun()
    const hidden = await f.addRun()
    const snapshot = ready(await f.service.getView({ ...request, runPages: { 1: 0 } }))
    expect((await f.service.getViewNode({ ...request, snapshotId: snapshot.snapshotId, nodeId: planNodeId(1, 2) })).kind).toBe('plan')
    await expect(f.service.getViewNode({ ...request, snapshotId: snapshot.snapshotId, nodeId: runNodeId(hidden.runId) })).rejects.toMatchObject(domainError('RESEARCH_NOT_FOUND'))
    await f.addVersion(1, 2)
    await expect(f.service.getViewNode({ ...request, snapshotId: snapshot.snapshotId, nodeId: snapshot.nodes[0]!.id })).rejects.toMatchObject(domainError('RESEARCH_VIEW_STALE'))
    await expect(f.service.renderView({ ...request, snapshotId: snapshot.snapshotId, ...theme })).rejects.toMatchObject(domainError('RESEARCH_VIEW_STALE'))
    expect(f.renderWorkflow).not.toHaveBeenCalled()
  })

  it('passes only projected workflow spec to native and hashes engine, theme and locale into the artifact revision', async () => {
    const f = await serviceFixture()
    const snapshot = ready(await f.service.getView(request))
    const result = await f.service.renderView({ ...request, snapshotId: snapshot.snapshotId, ...theme })
    const nativeRequest = f.renderWorkflow.mock.calls[0]![0]
    expect(Object.keys(nativeRequest).sort()).toEqual(['locale', 'spec', 'theme'])
    expect(nativeRequest.spec).toMatchObject({ schema_version: 2, diagram_type: 'workflow' })
    expect(JSON.stringify(nativeRequest.spec)).not.toContain(f.root)
    expect(result.revision).toBe(createHash('sha256').update(JSON.stringify([snapshot.snapshotId, result.specSha256, result.engineFingerprint, 'light', 'en'])).digest('hex'))
    expect(await f.service.renderView({ ...request, snapshotId: snapshot.snapshotId, ...theme })).toEqual(result)
    expect(f.renderWorkflow).toHaveBeenCalledTimes(1)
    const dark = await f.service.renderView({ ...request, snapshotId: snapshot.snapshotId, ...theme, theme: 'dark' })
    const chinese = await f.service.renderView({ ...request, snapshotId: snapshot.snapshotId, ...theme, locale: 'zh-CN' })
    expect(new Set([result.revision, dark.revision, chinese.revision]).size).toBe(3)
  })

  it('enforces complete render/detail UTF-8 wrapper budgets at tiny, exact and one-byte-short limits', async () => {
    const f = await serviceFixture()
    const snapshot = ready(await f.service.getView(request))
    const detailRequest = { ...request, snapshotId: snapshot.snapshotId, nodeId: snapshot.nodes[0]!.id }
    const detail = await f.service.getViewNode(detailRequest)
    const artifact = await f.service.renderView({ ...request, snapshotId: snapshot.snapshotId, ...theme })
    const renderBytes = Buffer.byteLength(JSON.stringify(artifact))
    expect(renderBytes).toBeGreaterThan(JSON.stringify(artifact).length)
    // Artifact wrapper lengths are stable across target/snapshot identity values.
    for (const limit of [1, renderBytes - 1, renderBytes]) {
      const other = await serviceFixture({ maxRenderBytes: limit })
      const page = ready(await other.service.getView(request))
      const operation = other.service.renderView({ ...request, snapshotId: page.snapshotId, ...theme })
      if (limit === renderBytes) expect(Buffer.byteLength(JSON.stringify(await operation))).toBe(limit)
      else await expect(operation).rejects.toMatchObject(domainError('RESEARCH_OVERSIZED'))
    }
    const limited = await serviceFixture({ maxDetailBytes: 1 })
    const page = ready(await limited.service.getView(request))
    await expect(limited.service.getViewNode({ ...request, snapshotId: page.snapshotId, nodeId: page.nodes[0]!.id })).rejects.toMatchObject(domainError('RESEARCH_OVERSIZED'))
    const detailBytes = Buffer.byteLength(JSON.stringify(detail))
    expect(detailBytes).toBeGreaterThan(JSON.stringify(detail).length)
    for (const limit of [detailBytes - 1, detailBytes]) {
      const other = await serviceFixture({ maxDetailBytes: limit })
      const page = ready(await other.service.getView(request))
      const operation = other.service.getViewNode({ ...request, snapshotId: page.snapshotId, nodeId: page.nodes[0]!.id })
      if (limit === detailBytes) expect(Buffer.byteLength(JSON.stringify(await operation))).toBe(limit)
      else await expect(operation).rejects.toMatchObject(domainError('RESEARCH_OVERSIZED'))
    }
  }, 15000)

  it('preserves native diagnostics without caching failures or changing the projected spec', async () => {
    const f = await serviceFixture()
    const page = ready(await f.service.getView(request))
    f.renderWorkflow.mockRejectedValueOnce(new Error('causal edge label collides with node: measured result'))
    await expect(f.service.renderView({ ...request, snapshotId: page.snapshotId, ...theme })).rejects.toMatchObject({ ...domainError('RESEARCH_VIEW_UNAVAILABLE'), message: 'causal edge label collides with node: measured result' })
    expect((await f.service.renderView({ ...request, snapshotId: page.snapshotId, ...theme })).nodeIds).toEqual(page.nodes.map(node => node.id))
    expect(f.renderWorkflow.mock.calls[1]![0]).toEqual(f.renderWorkflow.mock.calls[0]![0])
  })

  it('avoids acquiring leases for pre-canceled calls and releases a lease canceled while resolving its workspace', async () => {
    const f = await serviceFixture()
    await expect(f.service.getView(request, AbortSignal.abort())).rejects.toBeDefined()
    expect(f.observeSession).not.toHaveBeenCalled()
    const start = deferred<void>(); const finish = deferred<string>(); const caller = new AbortController()
    f.viewWorkspace.mockImplementationOnce(async () => { start.resolve(); return finish.promise })
    const operation = f.service.getView(request, caller.signal)
    const rejection = expect(operation).rejects.toBeDefined()
    await start.promise; caller.abort(); finish.resolve(f.root); await rejection
    expect(f.leases).toHaveLength(1)
    expect(f.leases[0]).toHaveBeenCalledTimes(1)
    expect(f.viewData).not.toHaveBeenCalled()
  })

  it('rechecks external authority and Session binding after asynchronous rendering', async () => {
    const f = await serviceFixture()
    for (const change of ['authority', 'binding'] as const) {
      f.observations.set(request.sessionId, { cwd: f.root, researchId: f.target.id })
      const snapshot = ready(await f.service.getView(request))
      const started = deferred<void>(); const output = deferred<ArchifyRenderResult>()
      f.renderWorkflow.mockImplementationOnce(async input => { started.resolve(); const artifact = await output.promise; return { ...rendered(input), ...artifact } })
      const operation = f.service.renderView({ ...request, snapshotId: snapshot.snapshotId, ...theme })
      const rejection = expect(operation).rejects.toMatchObject(domainError('RESEARCH_VIEW_STALE'))
      await started.promise
      if (change === 'authority') await f.addVersion(1, 1)
      else f.observations.set(request.sessionId, { cwd: f.root, researchId: null })
      output.resolve(rendered(f.renderWorkflow.mock.calls.at(-1)![0]))
      await rejection
    }
  })

  it('aborts native work on changed target, page eviction, caller abort and service disposal', async () => {
    const f = await serviceFixture({ cacheEntries: 1, runsPerVersionPage: 1 })
    await f.addVersion(1, 1)
    await f.addRun()
    await f.addRun()
    for (const action of ['change', 'evict', 'caller', 'dispose'] as const) {
      const page = ready(await f.service.getView({ ...request, runPages: { 1: 0 } }))
      const started = deferred<AbortSignal>(); const caller = new AbortController()
      f.renderWorkflow.mockImplementationOnce(async (_input, signal) => {
        if (signal === undefined) throw new Error('renderer requires operation signal')
        started.resolve(signal)
        return new Promise<ArchifyRenderResult>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      })
      const operation = f.service.renderView({ ...request, snapshotId: page.snapshotId, ...theme }, caller.signal)
      const rejection = expect(operation).rejects.toBeDefined()
      const signal = await started.promise
      if (action === 'change') f.context.emit('researcher/changed', { workspaceRoot: f.root, researchId: f.target.id })
      else if (action === 'evict') await f.service.getView({ ...request, runPages: { 1: 1 } })
      else if (action === 'caller') caller.abort()
      else await f.fiber.dispose()
      await rejection
      expect(signal.aborted).toBe(true)
    }
    await expect(f.service.getView(request)).rejects.toMatchObject(domainError('RESEARCH_VIEW_UNAVAILABLE'))
  })

  it('does not return native output after cancellation even if the provider settles late', async () => {
    const f = await serviceFixture()
    const page = ready(await f.service.getView(request))
    const start = deferred<void>(); const finish = deferred<ArchifyRenderResult>(); const caller = new AbortController()
    f.renderWorkflow.mockImplementationOnce(async () => { start.resolve(); return finish.promise })
    const operation = f.service.renderView({ ...request, snapshotId: page.snapshotId, ...theme }, caller.signal)
    const rejection = expect(operation).rejects.toBeDefined()
    await start.promise; caller.abort(); finish.resolve(rendered(f.renderWorkflow.mock.calls[0]![0]))
    await rejection
  })
})

describe('research view stream lifecycle', () => {
  it('yields initially, coalesces matching changes, ignores other scopes and closes without listeners', async () => {
    const f = await serviceFixture()
    const originalOn = f.context.on
    const removals: ReturnType<typeof vi.fn>[] = []
    const registrations = vi.spyOn(f.context, 'on').mockImplementation(function (this: typeof f.context, ...args: Parameters<typeof originalOn>) {
      const remove = Reflect.apply(originalOn, this, args) as () => boolean
      const tracked = vi.fn(remove); removals.push(tracked); return tracked
    })
    const caller = new AbortController()
    const iterator = f.service.watchView(request, caller.signal)[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(registrations.mock.calls.some(([name]) => name === 'researcher/changed')).toBe(true)
    f.context.emit('researcher/changed', { workspaceRoot: f.root, researchId: f.target.id })
    f.context.emit('researcher/changed', { workspaceRoot: f.root, researchId: f.target.id })
    expect(await iterator.next()).toEqual(first)
    const waiting = iterator.next(); let settled = false
    void waiting.then(() => { settled = true }, () => { settled = true })
    f.context.emit('researcher/changed', { workspaceRoot: '/other', researchId: f.target.id })
    f.context.emit('researcher/changed', { workspaceRoot: f.root, researchId: parseResearchId('123e4567-e89b-42d3-a456-426614174099') })
    await Promise.resolve(); expect(settled).toBe(false)
    const rejected = expect(waiting).rejects.toBeDefined(); caller.abort(); await rejected
    expect(await iterator.return?.()).toMatchObject({ done: true })
    expect(removals).toHaveLength(1)
    expect(removals[0]).toHaveBeenCalledTimes(1)
    expect(f.leases.every(lease => lease.mock.calls.length === 1)).toBe(true)
  })

  it('keeps the first invalidation across the subscribe race and disposes a pending stream with the service', async () => {
    const f = await serviceFixture()
    const original = f.observeSession.getMockImplementation()!
    f.observeSession.mockImplementationOnce(async (id, options) => {
      const value = await original(id, options)
      f.context.emit('researcher/changed', { workspaceRoot: f.root, researchId: f.target.id })
      return value
    })
    const stream = f.service.watchView(request)[Symbol.asyncIterator]()
    expect((await stream.next()).done).toBe(false)
    const next = stream.next(); const rejected = expect(next).rejects.toBeDefined()
    await f.fiber.dispose(); await rejected
    const fresh = f.service.watchView(request)[Symbol.asyncIterator]()
    await expect(fresh.next()).rejects.toMatchObject(domainError('RESEARCH_VIEW_UNAVAILABLE'))
  })

  it('closes a stream paused at a yield and allows an unbound Session to see first workspace changes', async () => {
    const f = await serviceFixture()
    f.observations.set(request.sessionId, { cwd: f.root, researchId: null })
    const stream = f.service.watchView(request)[Symbol.asyncIterator]()
    const first = (await stream.next()).value as ResearchViewChanged
    f.context.emit('researcher/changed', { workspaceRoot: f.root, researchId: f.target.id })
    const next = (await stream.next()).value as ResearchViewChanged
    expect(next.targetToken).not.toBe(first.targetToken)
    expect(await stream.return?.()).toMatchObject({ done: true })
  })
})
