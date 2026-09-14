import type { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyTools } from '../src/tool.ts'
import { ResearchStore } from '../src/storage.ts'
import { makeWorkspace, mockCheckpoints, removeWorkspace, testContext, testReproduction, testSession } from './helpers.ts'
import { recoveryHost } from './recovery-helpers.ts'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await removeWorkspace(root) })

async function bench() {
  const root = await makeWorkspace('researcher-plan-tools'); roots.push(root)
  const ctx = testContext(root)
  const checkpoints = mockCheckpoints()
  const store = new ResearchStore(ctx, checkpoints)
  const target = await store.createTarget(testSession(root), { goal: 'Keep general plans and exact run provenance', metrics: ['verified records'], baseline: 'no plans yet' })
  const host = recoveryHost(ctx, store, root)
  await host.service.load(host.agent, target.id)
  const agent = Object.assign(host.agent as object, { status: 'running' })
  const boundary = host.log.length
  host.appendEvent({ type: 'turn/start' })
  host.appendEvent({ type: 'user/message', data: { source: { kind: 'user' } } })
  let isRoot = true
  const definitions = new Map<string, ToolDefinition>()
  applyTools({
    agents: { get: () => agent, currentInitiator: () => agent, roots: () => isRoot ? [agent] : [] },
    sessionProjections: { stateOf: () => ({ openTurnStartSeq: boundary }) },
    goals: host.goals, researcher: host.service,
    tools: { register: (tool: ToolDefinition) => definitions.set(tool.name, tool) },
  } as unknown as Context)
  async function invoke(name: string, args: object = {}) {
    const tool = definitions.get(name)!
    const value = await tool.execute(args as never, { agent } as never)
    expect(validateJsonSchemaValue(tool.output.schema, value)).toEqual([])
    return value as any
  }
  return { root, ctx, store, target, host, checkpoints, invoke, definitions, denyRoot: () => { isRoot = false } }
}

describe('first-class plan public tools', () => {
  it('prompts both plan tools for important tradeoffs and supporting evidence without requiring a template', async () => {
    const b = await bench()
    for (const name of ['create_research_plan', 'update_research_plan']) {
      const description = b.definitions.get(name)!.parameters.properties!.body!.description
      expect(description).toContain('For important choices, explain the main tradeoffs and the basis for the chosen approach')
      expect(description).toContain('referencing relevant evidence or sources when available')
      expect(description).toContain('No prescribed headings or mandatory survey')
    }
  })

  it('keeps latest separate from selection, pins runs and restores bounded context in another session', async () => {
    const b = await bench()
    const startArgs = { purpose: 'Check the planned fixture', parameters: {}, reproduction: testReproduction(), plan: { plan_id: 1, revision: 1 } }
    await expect(b.invoke('start_research_run', startArgs)).rejects.toMatchObject({ code: 'RESEARCH_PLAN_REQUIRED' })
    expect(b.checkpoints.start).not.toHaveBeenCalled()
    const first = await b.invoke('create_research_plan', { title: 'No mandatory headings', body: 'DOMAIN_AGNOSTIC_BODY_'.repeat(1700), delta: ['Initial proposal'] })
    expect(first).toMatchObject({ plan_id: 1, revision: 1, schema_version: 2, based_on_runs: [] })
    const second = await b.invoke('update_research_plan', { plan_id: 1, expected_revision: 1, title: 'A revised route', body: 'Any complete free-form text.', delta: ['Change the approach'] })
    const before = (await b.invoke('get_research')).research
    expect(before).not.toHaveProperty('selected_plan')
    const selected = await b.invoke('select_research_plan', { plan_id: 1, revision: 1, expected_state_revision: before.revision })
    expect(selected.state.selected_plan).toEqual({ plan_id: 1, revision: 1, sha256: first.sha256 })
    expect((await b.invoke('get_research_plan', { plan_id: 1 })).revision).toBe(2)
    expect((await b.invoke('list_research_plans')).plans[0]).toMatchObject({ plan_id: 1, latest_revision: 2, sha256: second.sha256 })
    const current = (await b.invoke('get_research')).research
    expect(current.selected_plan).toEqual(selected.state.selected_plan)
    expect(current.context.length).toBeLessThanOrEqual(32 * 1024)
    expect(current.context).not.toContain('DOMAIN_AGNOSTIC_BODY_')
    expect(current.context).toContain(first.path)
    await expect(b.invoke('start_research_run', { ...startArgs, plan: { plan_id: 1, revision: 2 } })).rejects.toMatchObject({ code: 'RESEARCH_PLAN_CONFLICT' })
    expect(b.checkpoints.start).not.toHaveBeenCalled()
    const run = await b.invoke('start_research_run', startArgs)
    expect(run.plan_ref).toEqual(selected.state.selected_plan)
    expect((await b.store.readRun(b.host.session, b.target.id, run.run_id)).description).toMatchObject({ version: 3, planRef: { planId: 1, revision: 1, sha256: first.sha256 } })
    await expect(b.invoke('select_research_plan', { plan_id: 1, revision: 2, expected_state_revision: current.revision })).rejects.toMatchObject({ code: 'RESEARCH_RUN_OPEN' })
    await b.invoke('update_research_plan', { plan_id: 1, expected_revision: 2, title: 'Next candidate', body: 'Still no required template.', delta: ['Future improvement'] })
    const finished = await b.invoke('finish_research_run', { run_id: run.run_id, status: 'completed', result: 'Original plan evaluated', metrics: { valid: true }, decision: 'keep', artifacts: [], research_status: 'active', summary: 'Validated exact first revision' })
    expect(finished.plan_ref).toEqual(run.plan_ref)
    expect(finished.research_state.selected_plan).toEqual(run.plan_ref)
    const changed = await b.invoke('update_research', { status: 'active', summary: 'Selection survives ordinary state updates' })
    expect(changed.state.selected_plan).toEqual(run.plan_ref)
    const fresh = recoveryHost(b.ctx, new ResearchStore(b.ctx, b.checkpoints), b.root)
    const loaded = await fresh.service.load(fresh.agent, b.target.id)
    expect(loaded.target.state.selectedPlanRef).toEqual({ planId: 1, revision: 1, sha256: first.sha256 })
    expect(loaded.target.selectedPlan?.path).toBe(first.path)
    expect(loaded.context.text).not.toContain('DOMAIN_AGNOSTIC_BODY_')
  })

  it('reports changed plan bytes without blessing the ledger or creating another checkpoint', async () => {
    const b = await bench()
    const plan = await b.invoke('create_research_plan', { title: 'Integrity', body: 'A complete paragraph is sufficient.', delta: ['Initial'] })
    const state = (await b.invoke('get_research')).research
    await b.invoke('select_research_plan', { plan_id: 1, revision: 1, expected_state_revision: state.revision })
    const ledgerPath = path.join(b.root, b.target.root, 'plan/0001/versions.jsonl')
    const ledger = await readFile(ledgerPath, 'utf8')
    await writeFile(path.join(b.root, plan.path), plan.markdown + ' ')
    await expect(b.invoke('get_research_plan', { plan_id: 1 })).rejects.toThrow(/SHA|digest|hash/u)
    expect((await b.invoke('list_research_plans')).invalid).toHaveLength(1)
    const diagnostic = (await b.invoke('get_research')).research
    expect(diagnostic.selected_plan.sha256).toBe(plan.sha256)
    expect(diagnostic.warnings.join(' ')).toContain('integrity error')
    await expect(b.invoke('start_research_run', { purpose: 'Must not start', parameters: {}, reproduction: testReproduction(), plan: { plan_id: 1, revision: 1 } })).rejects.toThrow()
    expect(b.checkpoints.start).not.toHaveBeenCalled()
    expect(await readFile(ledgerPath, 'utf8')).toBe(ledger)
  })

  it('bounds summary titles without imposing a content-format limit on the saved plan', async () => {
    const b = await bench()
    const title = '通用方案标题'.repeat(1000)
    await b.invoke('create_research_plan', { title, body: 'A free-form paragraph.', delta: ['Initial'] })
    const before = (await b.invoke('get_research')).research
    await b.invoke('select_research_plan', { plan_id: 1, revision: 1, expected_state_revision: before.revision })
    expect((await b.invoke('get_research_plan', { plan_id: 1 })).title).toBe(title)
    expect((await b.invoke('list_research_plans')).plans[0].title.length).toBeLessThanOrEqual(120)
    const current = (await b.invoke('get_research')).research
    expect(current.selected_plan_title).toBe(title.slice(0, 500))
    expect(current.context.length).toBeLessThanOrEqual(32 * 1024)
    expect(current.context).not.toContain(title)
  })

  it('enforces only minimal content and Host mutation authority', async () => {
    const b = await bench()
    for (const input of [
      { title: ' ', body: 'Body', delta: ['Initial'] },
      { title: 'Title', body: '\n ', delta: ['Initial'] },
      { title: 'Title', body: 'Body', delta: [] },
      { title: 'Title', body: 'Body', delta: [' '] },
    ]) await expect(b.invoke('create_research_plan', input)).rejects.toThrow()
    expect((await b.invoke('list_research_plans')).plans).toEqual([])
    const value = await b.invoke('create_research_plan', { title: 'x', body: 'y', delta: ['z'] })
    expect(value.body).toBe('y')
    b.denyRoot()
    await expect(b.invoke('create_research_plan', { title: 'Denied', body: 'Still denied', delta: ['Initial'] })).rejects.toMatchObject({ code: 'RESEARCH_AUTHORITY_REQUIRED' })
    expect((await b.invoke('get_research_plan', { plan_id: 1 })).revision).toBe(1)
  })
})
