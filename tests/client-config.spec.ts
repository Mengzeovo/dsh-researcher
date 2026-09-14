/** Real browser-style Cordis Loader startup: create({name}), never Host config forwarding. */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { ResearchViewClientConfig } from '../src/types.ts'
import * as client from '../src/client/index.ts'

type Handshake = (signal?: AbortSignal) => Promise<RemoteResult<ResearchViewClientConfig>>
interface BrowserLoader {
  internal: { import(name: string): Promise<unknown> }
  create(options: { name: string }): Promise<string>
  resolve(id: string): { fiber: Fiber & PromiseLike<Fiber> }
}

async function fixture(handshake: Handshake, beforeViewInstall?: () => void) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const dshRoot = resolve(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess'))), '../../../..')
  const { default: Loader } = await import(/* @vite-ignore */ pathToFileURL(resolve(dshRoot, 'vendor/loader/lib/index.js')).href)
  await ctx.plugin(Loader)
  await ctx.plugin(TypertRegistry)
  const loader = ctx.get('loader') as unknown as BrowserLoader
  loader.internal = { import: async name => {
    expect(name).toBe('dsh-profile-researcher')
    return client
  } }
  // These providers replace only the external transport and UI services; Loader, plugin,
  // handshake, view registration and effect teardown run their real implementations.
  const provide = (name: string, value: unknown) => ctx.provide(name, value)
  const slots = new Map<string, { id: string; label(): string }>()
  const rules = new Map<string, { isVisible(summary: { projectionValues: { agentPreset: string } }): boolean }>()
  const layouts = new Map<string, 'page'>()
  const viewers = new Set<string>()
  const decorations = new Set<string>()
  const decorationEvents: string[] = []
  const mounted = new Set<string>()
  let dictionary: Record<string, string> = {}
  const getViewConfig = vi.fn(handshake)
  const mount = vi.fn(async (contribution: TypertRemoteContribution) => {
    const unregister = ctx.typert.remotes.register(contribution)
    const namespaces = [...new Set(contribution.descriptors.map(descriptor => descriptor.namespace))]
    const disposers = namespaces.map(name => {
      const retire = provide('remote.' + name, name === 'researcher' ? { getViewConfig } : {})
      mounted.add(name)
      return async () => { mounted.delete(name); await retire() }
    })
    return async () => {
      for (const dispose of disposers.reverse()) await dispose()
      await unregister()
    }
  })
  provide('remote', { $mount: mount })
  provide('sessions', { binding: () => undefined })
  provide('commandUi', { decorate: (value: { name: string }) => {
    decorations.add(value.name); decorationEvents.push('add:' + value.name)
    return () => { decorations.delete(value.name); decorationEvents.push('remove:' + value.name) }
  } })
  provide('slots', {
    inject: (_name: string, factory: () => Iterable<() => void>) => ctx.effect(factory),
    register: (value: { id: string; label(): string }) => {
      slots.set(value.id, value)
      return () => { slots.delete(value.id) }
    },
  })
  provide('uiConversation', { viewLayouts: { register: (rule: { viewId: string; layout: 'page' }) => {
    layouts.set(rule.viewId, rule.layout)
    return () => { layouts.delete(rule.viewId) }
  } }, viewVisibility: { register: (rule: { viewId: string; isVisible(summary: { projectionValues: { agentPreset: string } }): boolean }) => {
    rules.set(rule.viewId, rule)
    return () => { rules.delete(rule.viewId) }
  } } })
  provide('archifyViewer', { registerViewer: (name: string) => {
    beforeViewInstall?.()
    viewers.add(name)
    return () => { viewers.delete(name) }
  } })
  provide('locale', {
    register: (_name: string, values: { zh: Record<string, string> }) => {
      dictionary = values.zh
      return () => { dictionary = {} }
    },
    bind: () => (key: string) => dictionary[key],
  })
  provide('theme', { getTheme: () => ({ mode: 'light' }) })
  return { ctx, slots, rules, layouts, viewers, decorations, decorationEvents, mounted, mount, getViewConfig,
    start: async () => {
      const id = await loader.create({ name: 'dsh-profile-researcher' })
      const fiber = loader.resolve(id).fiber
      await fiber
      return fiber
    },
  }
}

const enabled = { ok: true as const, value: { enabled: true, presetIds: ['special-research'] } }
const disabled = { ok: true as const, value: { enabled: false, presetIds: ['research'] } }

describe('Host-authoritative browser Loader configuration', () => {
  it('default create({name}) installs the visible tab using Host enabled and preset IDs', async () => {
    const f = await fixture(async () => enabled)
    const fiber = await f.start()
    expect(f.getViewConfig).toHaveBeenCalledOnce()
    expect(f.mount).toHaveBeenCalledOnce()
    expect(f.ctx.typert.remotes.list().map(descriptor => descriptor.namespace)).toContain('researchView')
    expect(f.slots.get('research-view')?.label()).toBe('视图')
    expect(f.layouts.get('research-view')).toBe('page')
    expect(f.rules.get('research-view')?.isVisible({ projectionValues: { agentPreset: 'special-research' } })).toBe(true)
    expect(f.rules.get('research-view')?.isVisible({ projectionValues: { agentPreset: 'research' } })).toBe(false)
    expect([...f.viewers]).toEqual(['research.view.diagram'])
    expect([...f.mounted]).toEqual(['researcher', 'researchView'])
    await fiber.dispose()
    expect(f.slots.size).toBe(0); expect(f.rules.size).toBe(0); expect(f.layouts.size).toBe(0); expect(f.viewers.size).toBe(0)
    expect(f.mounted.size).toBe(0); expect(f.decorations.size, f.decorationEvents.join()).toBe(0)
    expect(f.ctx.typert.remotes.list()).toEqual([])
    const reloaded = await f.start()
    expect(f.slots.has('research-view')).toBe(true)
    expect(f.layouts.get('research-view')).toBe('page')
    await reloaded.dispose()
    expect(f.ctx.typert.remotes.list()).toEqual([])
  })

  it('keeps Host-disabled deployments picker-only with one shared Remote registration', async () => {
    const f = await fixture(async () => disabled)
    const fiber = await f.start()
    expect([...f.decorations]).toEqual(['research-load'])
    expect(f.mount).toHaveBeenCalledOnce()
    expect(f.slots.size).toBe(0); expect(f.rules.size).toBe(0); expect(f.layouts.size).toBe(0); expect(f.viewers.size).toBe(0)
    await fiber.dispose()
    expect(f.mounted.size).toBe(0); expect(f.decorations.size, f.decorationEvents.join()).toBe(0)
  })

  it('fails closed and releases the Root mount when the handshake fails', async () => {
    const f = await fixture(async () => { throw new Error('fixture transport offline') })
    await expect(f.start()).rejects.toThrow('fixture transport offline')
    expect(f.mounted.size).toBe(0); expect(f.decorations.size, f.decorationEvents.join()).toBe(0)
    expect(f.slots.size).toBe(0); expect(f.rules.size).toBe(0); expect(f.layouts.size).toBe(0); expect(f.viewers.size).toBe(0)
  })

  it('fails closed on a structured Remote failure', async () => {
    const f = await fixture(async () => ({ ok: false, error: new RemoteError('researcher/domain', 'fixture refused', { code: 'FIXTURE' }) }))
    await expect(f.start()).rejects.toThrow('researcher view configuration failed: fixture refused')
    expect(f.mounted.size).toBe(0); expect(f.slots.size).toBe(0)
  })

  it('releases the picker and shared Remote registration when view installation fails', async () => {
    const f = await fixture(async () => enabled, () => { throw new Error('fixture view install failure') })
    await expect(f.start()).rejects.toThrow('fixture view install failure')
    expect(f.mounted.size).toBe(0); expect(f.decorations.size, f.decorationEvents.join()).toBe(0)
    expect(f.slots.size).toBe(0); expect(f.rules.size).toBe(0); expect(f.layouts.size).toBe(0); expect(f.viewers.size).toBe(0)
  })

  it('aborts a pending handshake and rejects a late answer without installing a tab', async () => {
    const entered = Promise.withResolvers<AbortSignal>()
    const answer = Promise.withResolvers<RemoteResult<ResearchViewClientConfig>>()
    const f = await fixture(async signal => { entered.resolve(signal!); return answer.promise })
    const starting = f.start()
    const rejected = expect(starting).rejects.toThrow()
    const signal = await entered.promise
    const aborted = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    const stopping = f.ctx.fiber.dispose()
    try { await aborted; expect(signal.aborted).toBe(true) } finally { answer.resolve(enabled) }
    await rejected; await stopping
    expect(f.mounted.size).toBe(0); expect(f.decorations.size, f.decorationEvents.join()).toBe(0)
    expect(f.slots.size).toBe(0); expect(f.rules.size).toBe(0); expect(f.layouts.size).toBe(0); expect(f.viewers.size).toBe(0)
  })
})
