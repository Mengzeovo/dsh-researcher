import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, researchOptions } from '../src/client/index.ts'
import { parseResearchId } from '../src/schema.ts'
import type { ResearchTargetList } from '../src/types.ts'

const ID = parseResearchId('123e4567-e89b-42d3-a456-426614174000')
const INVALID_ID = parseResearchId('123e4567-e89b-42d3-b456-426614174001')
const AT = '2026-03-01T00:00:00.000Z'

const list: ResearchTargetList = {
  version: 1,
  boundResearchId: ID,
  targets: [
    {
      id: ID,
      description: 'Primary research target',
      status: 'active',
      updatedAt: AT,
      warningCount: 2,
    },
  ],
  invalid: [
    {
      id: INVALID_ID,
      code: 'RESEARCH_INVALID_RECORD',
      detail: 'state.jsonl is malformed',
    },
  ],
}

describe('research popup option adapter', () => {
  it('marks the bound target active and retains invalid diagnostics as non-load ids', () => {
    const options = researchOptions(list)
    expect(options[0]).toEqual({
      id: ID,
      label: 'Primary research target',
      detail: `${ID} · active · ⚠ 2`,
      active: true,
    })
    expect(options[1]).toMatchObject({
      id: `invalid:${INVALID_ID}`,
      label: `Invalid research target: ${INVALID_ID}`,
    })
  })
})

describe('client Remote mount and popupSelect decoration', () => {
  function bench(remoteResult: unknown = { ok: true, value: list }) {
    let decoration: {
      available(session: { sessionId: string }): boolean
      ui: {
        options(session: { sessionId: string }, signal: AbortSignal): Promise<readonly { id: string }[]>
        onSelect(option: { id: string }, session: { sessionId: string }): Promise<void>
      }
    } | undefined
    const disposeRemote = vi.fn(async () => {})
    const mount = vi.fn(async () => disposeRemote)
    const listRemote = vi.fn(async () => remoteResult)
    const command = vi.fn(async () => ({ ok: true, value: { matched: true } }))
    const live = { command }
    const sessions = { binding: vi.fn(() => ({ session: live })) }
    const disposeDecoration = vi.fn()
    const commandUi = {
      decorate: vi.fn((value) => {
        decoration = value
        return disposeDecoration
      }),
    }
    const disposeUi = vi.fn(async () => {})
    const researcher = { list: listRemote, getViewConfig: vi.fn(async () => ({ ok: true, value: { enabled: false, presetIds: ['research'] } })) }
    const ctx = {
      effect: vi.fn((callback: () => () => void) => callback()),
      on: vi.fn(),
      remote: {
        $mount: mount,
        researcher,
      },
      get: (name: string) => name === 'remote.researcher' ? researcher : name === 'commandUi' ? commandUi : sessions,
      inject: vi.fn((_deps, callback: (injected: Context) => void | (() => void)) => {
        const dispose = callback(ctx as unknown as Context)
        return Object.assign(Promise.resolve(), {
          dispose: async () => {
            dispose?.()
            await disposeUi()
          },
        })
      }),
    }
    return {
      ctx: ctx as unknown as Context,
      get decoration() {
        if (decoration === undefined) throw new Error('decoration is not installed')
        return decoration
      },
      mount,
      listRemote,
      command,
      sessions,
      disposeRemote,
      disposeDecoration,
      disposeUi,
      commandUi,
      inject: ctx.inject,
    }
  }

  it('mounts its Remote before decorating and resubmits valid selections to Host command authority', async () => {
    const b = bench()
    const dispose = await apply(b.ctx)
    expect(b.mount).toHaveBeenCalledOnce()
    expect(b.inject).toHaveBeenCalledWith(
      ['commandUi', 'sessions', 'remote', 'remote.researcher'],
      expect.any(Function),
    )
    expect(b.commandUi.decorate).toHaveBeenCalledOnce()
    expect(b.decoration.available({ sessionId: 'session-1' })).toBe(true)

    const signal = new AbortController().signal
    const options = await b.decoration.ui.options({ sessionId: 'session-1' }, signal)
    expect(options).toHaveLength(2)
    expect(b.listRemote).toHaveBeenCalledWith({ sessionId: 'session-1' }, signal)

    await b.decoration.ui.onSelect({ id: String(ID) }, { sessionId: 'session-1' })
    expect(b.command).toHaveBeenCalledWith(`/research-load ${ID}`)
    await expect(b.decoration.ui.onSelect({ id: `invalid:${INVALID_ID}` }, { sessionId: 'session-1' }))
      .rejects.toThrow(/repair its project records/u)
    expect(b.command).toHaveBeenCalledOnce()

    await dispose()
    expect(b.disposeDecoration).toHaveBeenCalledOnce()
    expect(b.disposeUi).toHaveBeenCalledOnce()
    expect(b.disposeRemote).toHaveBeenCalledOnce()
  })

  it('surfaces Remote failures and absent Host commands', async () => {
    const failed = bench({ ok: false, error: { code: 'remote-failed', message: 'offline' } })
    await apply(failed.ctx)
    await expect(failed.decoration.ui.options({ sessionId: 'session-1' }, new AbortController().signal))
      .rejects.toThrow('research target listing failed: remote-failed: offline')

    const missing = bench()
    missing.command.mockResolvedValueOnce({ ok: true, value: { matched: false } })
    await apply(missing.ctx)
    await expect(missing.decoration.ui.onSelect({ id: String(ID) }, { sessionId: 'session-1' }))
      .rejects.toThrow(/offers no \/research-load command/u)
  })
})
