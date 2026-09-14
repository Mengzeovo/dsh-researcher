import type { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyCommand } from '../src/command.ts'
import { apply as applyTools } from '../src/tool.ts'
import { ResearchStore } from '../src/storage.ts'
import { failNextWrite, makeWorkspace, mockCheckpoints, removeWorkspace, startPlannedTestRun, testContext, testReproduction, testSession } from './helpers.ts'
import { recoveryHost } from './recovery-helpers.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await removeWorkspace(root)
})

describe('public recovery surfaces', () => {
  it.each(['open', 'pending-state'] as const)('exposes %s through command and strict tool output, then clears it after finish', async phase => {
    const root = await makeWorkspace('researcher-recovery-surfaces'); roots.push(root)
    const ctx = testContext(root)
    const checkpoints = mockCheckpoints()
    const store = new ResearchStore(ctx, checkpoints)
    const original = testSession(root, 'original-session')
    const target = await store.createTarget(original, { goal: 'Recover through public tools', metrics: ['schema-valid output'], baseline: 'unbound session' })
    const started = await startPlannedTestRun(store, original, target.id, { purpose: 'fixture', parameters: {}, reproduction: testReproduction() })
    const baseline = (await store.readTarget(original, target.id)).state
    const wireRef = { plan_id: started.planRef.planId, revision: started.planRef.revision, sha256: started.planRef.sha256 }
    const request = { runId: started.runId, status: 'completed' as const, result: 'Original result', metrics: { score: 42 }, decision: 'keep', artifacts: [], researchStatus: 'active' as const, summary: 'Original summary' }
    if (phase === 'pending-state') {
      await failNextWrite(ctx, `${target.root}/state.jsonl`, 'interrupted state', 'replaceIfVersion')
      await expect(store.finishRun(original, target.id, request)).rejects.toThrow('interrupted state')
    }
    const fresh = recoveryHost(ctx, new ResearchStore(ctx, checkpoints), root)
    let command: { handler(invocation: unknown): Promise<{ kind: string; text: string; sourceEventSeq: number }> } | undefined
    applyCommand({ commands: { register: (value: typeof command & { name: string }) => { if (value?.name === 'research-load') command = value } }, researcher: fresh.service } as unknown as Context)
    const reply = await command!.handler({ rawInput: target.id, attachments: [], agent: fresh.agent })
    expect(reply.kind).toBe('success')
    expect(reply.text).toContain('Goal action: unchanged')
    expect(reply.text).toContain('Automatic advancement is OFF')
    expect(reply.text).toContain(`Recovery phase: ${phase}`)
    expect(reply.text).toContain(started.runId)
    expect(reply.text).toContain(started.planRef.sha256)
    expect(reply.text).toContain('result.transition.status/summary/direction/next')
    expect(reply.sourceEventSeq).toBe(0)

    const agent = Object.assign(fresh.agent as object, { status: 'running' })
    const boundary = fresh.log.length
    fresh.appendEvent({ type: 'turn/start' })
    fresh.appendEvent({ type: 'user/message', data: { source: { kind: 'user' } } })
    const definitions = new Map<string, ToolDefinition>()
    applyTools({
      agents: { get: () => agent, currentInitiator: () => agent, roots: () => [agent] },
      sessionProjections: { stateOf: () => ({ openTurnStartSeq: boundary }) },
      goals: fresh.goals, researcher: fresh.service, tools: { register: (tool: ToolDefinition) => { definitions.set(tool.name, tool) } },
    } as unknown as Context)
    const get = definitions.get('get_research')!
    const value = await get.execute({}, { agent } as never)
    expect(validateJsonSchemaValue(get.output.schema, value)).toEqual([])
    expect(value).toMatchObject({ research: { selected_plan: wireRef, recovery: { run_id: started.runId, path: started.path, phase, output_ref: started.checkpoint.outputRef, plan_ref: wireRef } } })
    const finish = definitions.get('finish_research_run')!
    const finished = await finish.execute({ run_id: started.runId, status: request.status, result: request.result, metrics: request.metrics, decision: request.decision, artifacts: request.artifacts, research_status: request.researchStatus, summary: request.summary }, { agent } as never)
    expect(validateJsonSchemaValue(finish.output.schema, finished)).toEqual([])
    expect(finished).toMatchObject({ plan_ref: wireRef, research_state: { revision: baseline.revision + 1, selected_plan: wireRef } })
    const after = await get.execute({}, { agent } as never)
    expect(validateJsonSchemaValue(get.output.schema, after)).toEqual([])
    expect(after).not.toHaveProperty('research.recovery')
    expect(after).toMatchObject({ research: { revision: baseline.revision + 1, selected_plan: wireRef } })

    const start = definitions.get('start_research_run')!
    const nextRequest = { plan: { plan_id: wireRef.plan_id, revision: wireRef.revision }, purpose: 'next planned fixture', parameters: { seed: 8 }, reproduction: testReproduction() }
    await expect(start.execute({ ...nextRequest, plan: { ...nextRequest.plan, revision: wireRef.revision + 1 } }, { agent } as never)).rejects.toMatchObject({ code: 'RESEARCH_PLAN_CONFLICT' })
    expect(checkpoints.start).toHaveBeenCalledOnce()
    const next = await start.execute(nextRequest, { agent } as never)
    expect(validateJsonSchemaValue(start.output.schema, next)).toEqual([])
    expect(next).toMatchObject({ plan_ref: wireRef })
    expect(checkpoints.start).toHaveBeenCalledTimes(2)
    const nextFinished = await finish.execute({ run_id: (next as { run_id: string }).run_id, status: request.status, result: request.result, metrics: request.metrics, decision: request.decision, artifacts: request.artifacts, research_status: request.researchStatus, summary: request.summary }, { agent } as never)
    expect(validateJsonSchemaValue(finish.output.schema, nextFinished)).toEqual([])
    expect(nextFinished).toMatchObject({ plan_ref: wireRef, research_state: { revision: baseline.revision + 2, selected_plan: wireRef } })
    expect(await get.execute({}, { agent } as never)).not.toHaveProperty('research.recovery')
    for (const method of ['create', 'edit', 'resume', 'complete'] as const) expect(fresh.goals[method]).not.toHaveBeenCalled()
  })
})
