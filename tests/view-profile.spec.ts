/** Built profile acceptance: real Loader/App, JSONL persistence, filesystem and native rendering. */
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '../src/view-service.ts'
import type { ResearchStore } from '../src/research-store.ts'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { researchViewDetailSchema, researchViewRenderedSchema, researchViewResponseSchema, researchViewChangedSchema } from '../src/view-wire.ts'
import { describe, expect, it, onTestFinished } from 'vitest'
import { mockCheckpoints, testReproduction } from './helpers.ts'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const fixtureRoot = fileURLToPath(new URL('./fixtures/research-view/', import.meta.url))
const subprocessEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess'))
const dshRoot = process.env.DSH_SOURCE ?? path.resolve(path.dirname(subprocessEntry), '../../../..')
const nativeEntry = fileURLToPath(import.meta.resolve('dsh-archify-native'))

interface FixtureApp {
  readonly context: Context
  readonly activity: { agentsCreated: number; sessionsCreated: number; sessionEvents: number }
}

declare module '@deepseek-ai/cordis' {
  interface Context { researchViewFixture: FixtureApp }
}

/** Hash files independently of the researcher and persistence read implementations. */
async function treeBytes(root: string, relative = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name)
    if (entry.isDirectory()) Object.assign(result, await treeBytes(root, file))
    else result[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')
  }
  return result
}

/** Each boot gets a fresh Loader/App while all generations read the same private durable files. */
async function profileFixture(rpc = false) {
  for (const entry of [path.join(dshRoot, 'packages/boot/app-boot/lib/index.js'), path.join(packageRoot, 'lib/view-service.js'), nativeEntry]) {
    await access(entry).catch(() => { throw new Error('Built profile prerequisite missing: ' + entry + '; build the owning package before running view-profile.spec.ts') })
  }
  const root = await mkdtemp(path.join(tmpdir(), 'research-view-profile-'))
  const contexts: Context[] = []
  onTestFinished(async () => {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const workspace = path.join(root, 'workspace')
  const sessions = path.join(root, 'sessions')
  await mkdir(workspace); await mkdir(sessions)
  let config = await readFile(path.join(fixtureRoot, 'cordis.yml'), 'utf8')
  if (rpc) config = config.replace('name: "@RESEARCHER@/lib/index.js"', 'name: "dsh-profile-researcher"')
  const replacements = { DSH: dshRoot, WORKSPACE: workspace, SESSIONS: sessions, FIXTURE: fixtureRoot, NATIVE: nativeEntry, RESEARCHER: packageRoot }
  for (const [token, value] of Object.entries(replacements)) config = config.replaceAll('@' + token + '@', JSON.stringify(value).slice(1, -1))
  if (rpc) {
    await mkdir(path.join(root, 'node_modules'))
    await symlink(packageRoot, path.join(root, 'node_modules/dsh-profile-researcher'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { 'dsh-profile-researcher': 'file:' + packageRoot } }))
    expect(config).toContain('name: "dsh-profile-researcher"')
    for (const [id, relative] of [['typert', 'packages/typert/registry/lib/index.js'], ['typert-loader', 'packages/typert/loader/lib/index.js'], ['typert-gateway', 'packages/api/gateway/lib/index.js']]) {
      config += '\n- id: ' + id + '\n  name: ' + JSON.stringify(path.join(dshRoot, relative!)) + '\n'
    }
  }
  const configPath = path.join(root, 'cordis.yml')
  await writeFile(configPath, config)
  // Explicit built-plane import: no source-path resolver, fake Loader import map or manual plugin mounts.
  const bootModule = await import(/* @vite-ignore */ pathToFileURL(path.join(dshRoot, 'packages/boot/app-boot/lib/index.js')).href)
  const boot: (name: string, config: string, patches?: unknown[]) => Promise<Context> = bootModule.boot
  const start = async (patches?: unknown[]) => {
    const ctx = await boot('research-view-acceptance', configPath, patches)
    contexts.push(ctx)
    const app = ctx.get('researchViewFixture')!
    expect(app).toBeDefined()
    return { root: ctx, ctx: app.context, activity: app.activity }
  }
  return { root, workspace, sessions, start }
}

/** Only Git checkpoint capture is replaced; authority publication uses the actual local filesystem. */
async function seed(ctx: Context, workspace: string) {
  const module = await import(/* @vite-ignore */ pathToFileURL(path.join(packageRoot, 'lib/research-store.js')).href)
  const store: ResearchStore = new module.ResearchStore(ctx, mockCheckpoints())
  const contextModule: typeof import('../src/context.ts') = await import(/* @vite-ignore */ pathToFileURL(path.join(packageRoot, 'lib/context.js')).href)
  const session = ctx.sessions.create(SessionId('research-view-cold'), { meta: { cwd: workspace } })
  const target = await store.createTarget(session, { goal: 'Cold saved Session research view', metrics: ['exact recorded evidence'], baseline: 'first plan' })
  const plan = await store.createPlan(session, target.id, { title: 'Estimator v1', body: 'Measure estimator error.', delta: ['Initial plan'] })
  const state = await store.readTarget(session, target.id)
  await store.selectPlan(session, target.id, { planId: 1, revision: 1, expectedStateRevision: state.state.revision })
  const run = await store.startRun(session, target.id, { plan: { planId: 1, revision: 1 }, purpose: 'Measure error', parameters: { seed: 7 }, reproduction: testReproduction() })
  await store.finishRun(session, target.id, { runId: run.runId, status: 'completed', result: 'Error remained high', metrics: { error: 0.3 }, decision: 'Revise estimator', artifacts: [], researchStatus: 'active', summary: 'One run recorded' })
  await store.updatePlan(session, target.id, { planId: 1, expectedRevision: 1, title: 'Estimator v2', body: 'Use the observed error to revise the estimator.', delta: ['Revise after measurement'], basedOnRuns: [{ runId: run.runId, reason: 'Observed error motivates revision' }] })
  const binding = { version: 1 as const, researchId: target.id, sessionId: String(session.id), loadedAt: new Date().toISOString() }
  const message = contextModule.createResearchContextMessage(contextModule.buildResearchContext(await store.readTarget(session, target.id), binding))
  session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 0, inserted: [message] })
  const peer = ctx.sessions.create(SessionId('research-view-bound-peer'), { meta: { cwd: workspace } })
  const peerMessage = contextModule.createResearchContextMessage(contextModule.buildResearchContext(await store.readTarget(session, target.id), { ...binding, sessionId: String(peer.id) }))
  peer.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 0, inserted: [peerMessage] })
  const unbound = ctx.sessions.create(SessionId('research-view-unbound'), { meta: { cwd: workspace } })
  for (const saved of [session, peer, unbound]) await save(ctx, saved)
  return { sessionId: String(session.id), peerId: String(peer.id), unboundId: String(unbound.id), researchId: target.id, plan, run }
}

async function save(ctx: Context, session: Session): Promise<void> {
  const handle = await ctx.sessionPersistence.create(session.header)
  try { await handle.append(session.snapshotEvents()); await handle.flush() }
  finally { await handle.close() }
}

function expectCold(app: { ctx: Context; activity: FixtureApp['activity'] }) {
  expect(app.ctx.agents.list()).toEqual([])
  expect(app.ctx.sessions.list()).toEqual([])
  expect(app.ctx.get('llm')).toBeUndefined()
  expect(app.ctx.get('agentLoop')).toBeUndefined()
  expect(app.activity).toEqual({ agentsCreated: 0, sessionsCreated: 0, sessionEvents: 0 })
}

describe('research view built Loader + App composition', () => {
  it('reads a cold saved binding, verified plans and runs and renders native HTML without Agent/model startup or authority writes', async () => {
    const f = await profileFixture()
    const writer = await f.start([{ id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: f.workspace } }])
    const seeded = await seed(writer.ctx, f.workspace)
    expect(writer.activity.agentsCreated).toBe(0)
    await writer.root.fiber.dispose()
    const beforeWorkspace = await treeBytes(f.workspace)
    const beforeSessions = await treeBytes(f.sessions)
    expect(Object.keys(beforeSessions).some(file => file.endsWith('.jsonl'))).toBe(true)
    const reader = await f.start()
    expect(reader.ctx.sandboxPolicy.resolve({}).mode).toBe('read-only')
    expectCold(reader)
    const view = reader.ctx.get('researchView')!
    expect(view).toBeDefined()
    expect(reader.ctx.get('archify')).toBeDefined()
    const request = { sessionId: seeded.sessionId, planId: 1 }
    const snapshot = await view.getView(request)
    expect(snapshot.kind).toBe('ready')
    if (snapshot.kind !== 'ready') throw new Error('Expected a populated research view')
    expect(snapshot.researchId).toBe(seeded.researchId)
    expect(snapshot.diagnostics).toEqual([])
    expect(snapshot.nodes.map(node => [node.kind, node.revision])).toEqual([['plan', 1], ['run', 1], ['plan', 2]])
    expect(snapshot.edges.map(edge => edge.kind).sort()).toEqual(['informs-plan', 'uses-plan'])
    expect(snapshot.edges.find(edge => edge.kind === 'informs-plan')?.label).toBe('Observed error motivates revision')
    // Snapshot the user-visible semantics replayed from the saved binding; random record identities are asserted separately.
    expect({
      nodes: snapshot.nodes.map(node => node.kind === 'plan'
        ? { kind: node.kind, revision: node.revision, title: node.title, summary: node.summary, selected: node.selected }
        : { kind: node.kind, revision: node.revision, title: node.title, summary: node.summary, status: node.status, pendingState: node.pendingState, metrics: node.metrics }),
      edges: snapshot.edges.map(edge => ({ kind: edge.kind, label: edge.label,
        from: snapshot.nodes.find(node => node.id === edge.from)?.kind,
        to: snapshot.nodes.find(node => node.id === edge.to)?.kind })),
    }).toMatchInlineSnapshot(
      `
{
  "edges": [
    {
      "from": "plan",
      "kind": "uses-plan",
      "label": "",
      "to": "run",
    },
    {
      "from": "run",
      "kind": "informs-plan",
      "label": "Observed error motivates revision",
      "to": "plan",
    },
  ],
  "nodes": [
    {
      "kind": "plan",
      "revision": 1,
      "selected": true,
      "summary": "Initial plan",
      "title": "Estimator v1",
    },
    {
      "kind": "run",
      "metrics": {
        "error": 0.3,
      },
      "pendingState": false,
      "revision": 1,
      "status": "completed",
      "summary": "Error remained high",
      "title": "Measure error",
    },
    {
      "kind": "plan",
      "revision": 2,
      "selected": false,
      "summary": "Revise after measurement",
      "title": "Estimator v2",
    },
  ],
}
`
    )
    const planNode = snapshot.nodes.find(node => node.kind === 'plan' && node.revision === 1)!
    const runNode = snapshot.nodes.find(node => node.kind === 'run')!
    expect(await view.getViewNode({ ...request, snapshotId: snapshot.snapshotId, nodeId: planNode.id })).toMatchObject({ kind: 'plan', document: { sha256: seeded.plan.plan.sha256 } })
    expect(await view.getViewNode({ ...request, snapshotId: snapshot.snapshotId, nodeId: runNode.id })).toMatchObject({ kind: 'run' })
    for (const locale of ['en', 'zh-CN'] as const) {
      const rendered = await view.renderView({ ...request, snapshotId: snapshot.snapshotId, theme: 'light', locale })
      expect(rendered.nodeIds).toEqual(snapshot.nodes.map(node => node.id))
      expect(rendered.html).toContain('data-dsh-archify-viewer="1"')
      expect(rendered.svg).toContain('data-edge-label="Observe…"')
      expect(rendered.svg).toContain(locale === 'en' ? 'Plan v1' : '方案 v1')
      expect(rendered.engineFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    }
    expect(await view.getView({ ...request, ifNoneMatch: snapshot.snapshotId })).toEqual({ kind: 'unchanged', snapshotId: snapshot.snapshotId })
    expect(await view.getViewNode({ sessionId: seeded.peerId, snapshotId: snapshot.snapshotId, nodeId: planNode.id })).toMatchObject({ kind: 'plan' })
    expect(await view.getView({ sessionId: seeded.unboundId })).toEqual({ kind: 'unbound' })
    await expect(view.getViewNode({ sessionId: seeded.unboundId, snapshotId: snapshot.snapshotId, nodeId: planNode.id })).rejects.toMatchObject({ code: 'researcher/domain', details: { code: 'RESEARCH_VIEW_STALE' } })
    expectCold(reader)
    expect(await treeBytes(f.workspace)).toEqual(beforeWorkspace)
    expect(await treeBytes(f.sessions)).toEqual(beforeSessions)
    await reader.root.fiber.dispose()
    await expect(view.getView(request)).rejects.toThrow('disposed')
    expect(await treeBytes(f.workspace)).toEqual(beforeWorkspace)
    expect(await treeBytes(f.sessions)).toEqual(beforeSessions)
  }, 60_000)

  it('auto-loads package Typert descriptors and dispatches all view methods through the real Gateway', async () => {
    const f = await profileFixture(true)
    const writer = await f.start([{ id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: f.workspace } }])
    const seeded = await seed(writer.ctx, f.workspace)
    await writer.root.fiber.dispose()
    const beforeWorkspace = await treeBytes(f.workspace)
    const beforeSessions = await treeBytes(f.sessions)
    const reader = await f.start()
    // The built infrastructure packages are loaded by the profile, not test-time module mocks.
    const registry = reader.ctx.get('typert') as unknown as { local: { get(endpoint: string): InvocationDescriptor | undefined } }
    type RpcRequest = { namespace: string; method: string; args: Record<string, unknown>; signal?: AbortSignal }
    const gateway = reader.ctx.get('typertGateway') as unknown as { invoke(request: RpcRequest): Promise<unknown>; stream(request: RpcRequest): Promise<AsyncIterable<unknown>> }
    expect(registry).toBeDefined(); expect(gateway).toBeDefined()
    expect(registry.local.get('researcher/getViewConfig')).toMatchObject({ service: 'researcher', method: 'getViewConfig', parameters: [], result: { mode: 'strict' } })
    expect(await gateway.invoke({ namespace: 'researcher', method: 'getViewConfig', args: {} })).toEqual({ enabled: true, presetIds: ['research'] })
    await expect(gateway.invoke({ namespace: 'researcher', method: 'getViewConfig', args: { config: { enabled: true } } })).rejects.toMatchObject({ code: 'gateway/arguments-invalid' })
    for (const method of ['getView', 'getViewNode', 'renderView', 'watchView']) {
      expect(registry.local.get('researchView/' + method)).toMatchObject({ id: 'dsh-profile-researcher#researchView/' + method, service: 'researchView', namespace: 'researchView', method, invocation: { kind: 'direct' }, result: { mode: 'strict' } })
    }
    const invoke = (method: string, request: Record<string, unknown>) => gateway.invoke({ namespace: 'researchView', method, args: { request } })
    const snapshot = researchViewResponseSchema.parse(await invoke('getView', { sessionId: seeded.sessionId }))
    if (snapshot.kind !== 'ready') throw new Error('Gateway did not return populated research view')
    const node = snapshot.nodes[0]!
    const detail = researchViewDetailSchema.parse(await invoke('getViewNode', { sessionId: seeded.sessionId, snapshotId: snapshot.snapshotId, nodeId: node.id }))
    expect(detail.node.id).toBe(node.id)
    const artifact = researchViewRenderedSchema.parse(await invoke('renderView', { sessionId: seeded.sessionId, snapshotId: snapshot.snapshotId, theme: 'light', locale: 'en' }))
    expect(artifact.nodeIds).toEqual(snapshot.nodes.map(item => item.id))
    const controller = new AbortController()
    const stream = await gateway.stream({ namespace: 'researchView', method: 'watchView', args: { request: { sessionId: seeded.sessionId } }, signal: controller.signal })
    const iterator = stream[Symbol.asyncIterator]()
    try { expect(researchViewChangedSchema.parse((await iterator.next()).value).targetToken).toBe(snapshot.targetToken) }
    finally { controller.abort(); await iterator.return?.() }
    await expect(invoke('renderView', { sessionId: seeded.sessionId, snapshotId: snapshot.snapshotId, theme: 'light', locale: 'en', spec: {} })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
    expectCold(reader)
    await reader.root.fiber.dispose()
    expect(await treeBytes(f.workspace)).toEqual(beforeWorkspace)
    expect(await treeBytes(f.sessions)).toEqual(beforeSessions)
    expect(registry.local.get('researchView/getView')).toBeUndefined()
    expect(registry.local.get('researcher/getViewConfig')).toBeUndefined()
  }, 60_000)

  it('leaves the view unmounted when the same profile opts out', async () => {
    const f = await profileFixture(true)
    const app = await f.start([{ id: 'researcher', config: { view: { enabled: false } } }])
    const beforeWorkspace = await treeBytes(f.workspace)
    const beforeSessions = await treeBytes(f.sessions)
    const gateway = app.ctx.get('typertGateway') as unknown as { invoke(request: { namespace: string; method: string; args: Record<string, unknown> }): Promise<unknown> }
    expect(await gateway.invoke({ namespace: 'researcher', method: 'getViewConfig', args: {} })).toEqual({ enabled: false, presetIds: ['research'] })
    expect(await treeBytes(f.workspace)).toEqual(beforeWorkspace)
    expect(await treeBytes(f.sessions)).toEqual(beforeSessions)
    expect(app.ctx.get('researcher')).toBeDefined()
    expect(app.ctx.get('researchView')).toBeUndefined()
    expectCold(app)
  })
})
