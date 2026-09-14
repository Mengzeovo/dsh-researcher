import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type {} from 'dsh-archify-native/types'
import { expect, it, onTestFinished } from 'vitest'
import { projectResearchView } from '../src/view-projection.ts'
import { researchWorkflow } from '../src/view-workflow.ts'
import { populatedViewFixture, viewConfig, viewRequest, viewToken } from './view-test-helpers.ts'

/** Built native and DSH artifacts are explicit prerequisites of this integration suite. */
it('renders a real projected 15-node causal page in both locales through the native Cordis service without an Agent', async () => {
  const f = await populatedViewFixture()
  const { snapshot } = projectResearchView(await f.read(), viewToken, viewRequest(), viewConfig)
  expect(snapshot.nodes).toHaveLength(15)
  expect(snapshot.edges.filter(edge => edge.kind === 'informs-plan')).toHaveLength(2)
  const subprocessEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess'))
  const source = process.env.DSH_SOURCE ?? path.resolve(path.dirname(subprocessEntry), '../../../..')
  // Built JavaScript plugins have no common declaration export; Cordis validates their composition.
  const load = (relative: string) => import(pathToFileURL(path.join(source, relative)).href)
  const { Context } = await load('vendor/cordis/lib/index.js')
  const ctx: CordisContext = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const { LocalSubprocessRuntime } = await load('packages/subprocess/subprocess-local/lib/index.js')
  const { default: SystemPrompt } = await load('packages/core/system-prompt/lib/index.js')
  const { default: ToolRuntime } = await load('packages/core/tools/lib/index.js')
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(LocalSubprocessRuntime)
  const nativeName = 'dsh-archify-native'
  const native = await import(nativeName)
  const fiber = ctx.plugin(native); await fiber
  const service = ctx.archify
  for (const locale of ['en', 'zh-CN'] as const) {
    const spec = researchWorkflow(snapshot, locale)
    const result = await service.renderWorkflow({ spec, theme: 'light', locale })
    expect(result.nodeIds).toEqual(snapshot.nodes.map(node => node.id))
    expect(result.html).toContain('data-dsh-archify-viewer="1"')
    expect(result.svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(result.svg).toContain('误差促成修订')
    expect(result.svg).toContain(locale === 'en' ? 'Plan v1' : '方案 v1')
    expect(result.svg).toContain(locale === 'en' ? 'Completed' : '已完成')
    expect(result.specSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(result.engineFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(spec).toMatchObject({ meta: { legend: { mode: 'hidden' } } })
    expect(result.svg).not.toContain('data-legend=""')
  }
  await fiber.dispose()
  await expect(service.renderWorkflow({ spec: researchWorkflow(snapshot, 'en'), theme: 'light', locale: 'en' })).rejects.toMatchObject({ code: 'disposed' })
}, 60000)
