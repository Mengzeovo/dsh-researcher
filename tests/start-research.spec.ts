import type { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply as applyTools } from '../src/tool.ts'
import { apply as applyCommand } from '../src/command.ts'
import { ResearcherError } from '../src/errors.ts'

const ID = '123e4567-e89b-42d3-a456-426614174000'

function fixture(source: unknown, root = true, previousHuman = false) {
  const events = [
    ...(previousHuman ? [{ type: 'user/message', data: { source: { kind: 'user' } } }] : []),
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source } },
  ]
  const session = { snapshotEvents: () => events, seq: events.length, eventAt: (seq: number) => events[seq] }
  const agent = { id: 'session-start', session, status: 'running' }
  const start = vi.fn(async () => ({ researchId: ID, target: { state: { status: 'active' } }, goalAction: 'created' }))
  const definitions = new Map<string, ToolDefinition>()
  const ctx = {
    agents: { get: () => agent, currentInitiator: () => agent, roots: () => root ? [agent] : [] },
    sessionProjections: { stateOf: () => ({ openTurnStartSeq: previousHuman ? 1 : 0 }) },
    researcher: { start }, tools: { register: (tool: ToolDefinition) => definitions.set(tool.name, tool) },
  } as unknown as Context
  applyTools(ctx)
  const tool = definitions.get('start_research')!
  return { start, tool, agent, invoke: () => tool.execute({}, { agent } as never) }
}

describe('explicit research startup tool authority', () => {
  it('shares service activation and returns the strict public result', async () => {
    const b = fixture({ kind: 'user' })
    const value = await b.invoke()
    expect(validateJsonSchemaValue(b.tool.output.schema, value)).toEqual([])
    expect(value).toEqual({ id: ID, status: 'active', goal_action: 'created' })
    expect(b.start).toHaveBeenCalledWith(b.agent, undefined)
    expect(b.tool.description).toContain('ONLY')
    expect(b.tool.description).toContain('single task')
  })

  it.each([
    { kind: 'plugin', plugin: 'researcher:briefing' },
    { kind: 'goal', goalId: 'goal-1', revision: 1, round: 1 },
    { kind: 'agent', agentId: 'child' },
  ])('rejects non-human startup %j even with historical human input', async source => {
    const b = fixture(source, true, true)
    await expect(b.invoke()).rejects.toMatchObject({ code: 'RESEARCH_AUTHORITY_REQUIRED' })
    expect(b.start).not.toHaveBeenCalled()
  })

  it('rejects an owned child even with a user-shaped input', async () => {
    const b = fixture({ kind: 'user' }, false)
    await expect(b.invoke()).rejects.toMatchObject({ code: 'RESEARCH_AUTHORITY_REQUIRED' })
    expect(b.start).not.toHaveBeenCalled()
  })
})

describe('/research-start command', () => {
  function bench() {
    const commands = new Map<string, { handler(input: unknown): Promise<unknown> }>()
    const start = vi.fn(async () => ({ researchId: ID, target: { state: { status: 'active' } }, goalAction: 'created' }))
    applyCommand({ commands: { register: (command: { name: string; handler(input: unknown): Promise<unknown> }) => commands.set(command.name, command) }, researcher: { start } } as unknown as Context)
    const agent = {}
    return { start, agent, command: commands.get('research-start')!, invoke: (rawInput = '', attachments: unknown[] = []) => commands.get('research-start')!.handler({ agent, rawInput, attachments }) }
  }
  it('registers without an input descriptor for the argument-free command', () => {
    expect(bench().command).not.toHaveProperty('input')
  })
  it('starts the current binding only, without a load or target-switch parameter', async () => {
    const b = bench()
    expect(await b.invoke()).toMatchObject({ kind: 'success', text: expect.stringContaining('Automatic advancement is ON') })
    expect(b.start).toHaveBeenCalledWith(b.agent, undefined)
  })
  it('rejects target IDs and attachments', async () => {
    const b = bench()
    expect(await b.invoke(ID)).toMatchObject({ kind: 'error' })
    expect(await b.invoke('', [{}])).toMatchObject({ kind: 'error' })
    expect(b.start).not.toHaveBeenCalled()
  })
  it('reports activation checks without falling back to load', async () => {
    const b = bench()
    b.start.mockRejectedValue(new ResearcherError('unfinished run', 'RESEARCH_RUN_OPEN'))
    expect(await b.invoke()).toEqual({ kind: 'error', text: 'RESEARCH_RUN_OPEN: unfinished run' })
  })
})
