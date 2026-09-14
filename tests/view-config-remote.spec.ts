import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { ResearcherService } from '../src/index.ts'
import { researchViewClientConfigSchema } from '../src/wire.ts'
import { resolveResearcherConfig } from '../src/view-config.ts'
import { viewConfigInvocation } from '../src/view-config-invocation.ts'
import host from '../src/typert.host.ts'
import remote from '../src/typert.remote-client.ts'

function fixture(config?: unknown) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const activity = vi.fn(() => { throw new Error('configuration must not access research or Agent data') })
  ctx.provide('sessionProjections', { register: vi.fn(() => () => {}) } as unknown as Context['sessionProjections'])
  ctx.provide('agents', { get: activity, create: activity, list: () => [] } as unknown as Context['agents'])
  ctx.provide('fs', { readFile: activity, writeFile: activity } as unknown as Context['fs'])
  ctx.provide('goals', { create: activity, update: activity } as unknown as Context['goals'])
  return { ctx, service: new ResearcherService(ctx, config), activity }
}

describe('Root researcher public view configuration', () => {
  it('returns disabled defaults without Session access or a view service', async () => {
    const f = fixture()
    expect(await f.service.getViewConfig()).toEqual({ enabled: false, presetIds: ['research'] })
    expect(f.ctx.get('researchView')).toBeUndefined()
    expect(f.activity).not.toHaveBeenCalled()
  })

  it('projects only public fields and does not lend mutable Host state', async () => {
    const f = fixture({ view: { enabled: true, presetIds: ['custom'], maxDataBytes: 12345, cacheEntries: 3 } })
    const result = await f.service.getViewConfig()
    expect(result).toEqual({ enabled: true, presetIds: ['custom'] })
    ;(result.presetIds as string[]).push('client-mutation')
    expect(await f.service.getViewConfig()).toEqual({ enabled: true, presetIds: ['custom'] })
    expect(f.activity).not.toHaveBeenCalled()
    const canceled = new AbortController(); canceled.abort()
    await expect(f.service.getViewConfig(canceled.signal)).rejects.toThrow()
  })

  it('rejects private or secret fields and missing or malformed public values at the wire', () => {
    const valid = { enabled: true, presetIds: ['research'] }
    expect(researchViewClientConfigSchema.parse(valid)).toEqual(valid)
    for (const extra of [{ apiKey: 'secret-sentinel' }, { maxDataBytes: 123 }, { config: { token: 'secret-sentinel' } }]) {
      expect(researchViewClientConfigSchema.safeParse({ ...valid, ...extra }).success).toBe(false)
    }
    for (const invalid of [{}, { enabled: 'true', presetIds: ['research'] }, { enabled: true, presetIds: [] }]) {
      expect(researchViewClientConfigSchema.safeParse(invalid).success).toBe(false)
    }
    expect(resolveResearcherConfig({}).view.enabled).toBe(false)
    expect(() => resolveResearcherConfig({ view: { versionsPerPage: 0 } })).toThrow()
  })

  it('shares the strict direct Root endpoint between both faces and lists it in the public catalog', () => {
    expect(host.invocations).toContain(viewConfigInvocation)
    expect(remote.descriptors).toContain(viewConfigInvocation)
    expect(viewConfigInvocation).toMatchObject({ service: 'researcher', namespace: 'researcher', method: 'getViewConfig', parameters: [], result: { mode: 'strict' } })
    const service = host.model.services.find(service => service.key === 'researcher')!
    expect(service.members.some(member => member.name === 'getViewConfig')).toBe(true)
    expect(service.types.some(type => type.name === 'ResearchViewClientConfig')).toBe(true)
  })
})
