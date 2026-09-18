import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type {} from 'dsh-archify-native/types'
import { expect, it, onTestFinished } from 'vitest'
import { projectResearchView } from '../src/view-projection.ts'
import { researchWorkflow } from '../src/view-workflow.ts'
import { populatedViewFixture, viewConfig, viewRequest, viewToken } from './view-test-helpers.ts'

/** Inspect actual SVG cards and routes rather than only echoed nodeIds. */
function expectCanvasGeometry(svg: string, nodeIds: string[], edges: { id: string, from: string, to: string }[], rows: number) {
  const attributes = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/gu)].map(match => [match[1], match[2]]))
  const root = attributes(svg.match(/<svg\b[^>]*>/u)?.[0] ?? "")
  const bounds = root.viewBox?.split(/\s+/u).map(Number) ?? []
  expect(bounds).toHaveLength(4)
  expect(bounds.every(Number.isFinite)).toBe(true)
  const [left, top, width, height] = bounds
  expect(width).toBeGreaterThan(0); expect(height).toBeGreaterThan(0)
  const inside = (x: number, y: number) => {
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true)
    expect(x).toBeGreaterThanOrEqual(left); expect(y).toBeGreaterThanOrEqual(top)
    expect(x).toBeLessThanOrEqual(left + width); expect(y).toBeLessThanOrEqual(top + height)
  }
  const cards = [...svg.matchAll(/<g\b([^>]*data-node-id="[^"]+"[^>]*)>\s*<title>[^<]*<\/title>\s*<rect\b([^>]*)/gu)].map(match => {
    const node = attributes(match[1]); const rect = attributes(match[2])
    return { id: node["data-node-id"], x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height) }
  })
  expect(cards.map(card => card.id).sort()).toEqual([...nodeIds].sort())
  for (const card of cards) {
    expect(card.width).toBeGreaterThan(0); expect(card.height).toBeGreaterThan(0)
    inside(card.x, card.y); inside(card.x + card.width, card.y + card.height)
  }
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i]; const b = cards[j]
    expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, "overlapping cards: " + a.id + ", " + b.id).toBe(true)
  }
  expect([...svg.matchAll(/data-composition-frame-kind="lane"/gu)]).toHaveLength(rows)
  const paths = [...svg.matchAll(/<path\b[^>]*data-edge-id="[^"]+"[^>]*>/gu)].map(match => attributes(match[0]))
  expect(paths.map(edge => ({ id: edge["data-edge-id"], from: edge["data-edge-from"], to: edge["data-edge-to"] })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([...edges].sort((a, b) => a.id.localeCompare(b.id)))
  for (const edge of paths) {
    const points = edge["data-composition-points"].trim().split(';')
    expect(points.length).toBeGreaterThanOrEqual(2)
    for (const point of points) { const [x, y] = point.split(",").map(Number); inside(x, y) }
    expect(edge.d).not.toMatch(/NaN|Infinity/u)
  }
}

/** Built native and DSH artifacts are explicit prerequisites of this integration suite. */
it.each([
  { revisions: 4, runs: 4, causal: true },
  { revisions: 7, runs: 4, causal: true },
  { revisions: 4, runs: 0, causal: false },
])('renders $revisions revisions with $runs Runs each wrapped at six columns on one canvas in both locales without an Agent', async ({ revisions, runs, causal }) => {
  const f = await populatedViewFixture(revisions, runs, causal)
  const { snapshot } = projectResearchView(await f.read(), viewToken, viewRequest(), viewConfig)
  expect(snapshot.nodes).toHaveLength(revisions * (runs + 1))
  expect(Math.max(...snapshot.nodes.map(node => node.column))).toBe(revisions * 2 - (runs === 0 ? 2 : 1))
  expect(snapshot.edges.filter(edge => edge.kind === (causal ? 'informs-plan' : 'revises-plan'))).toHaveLength(revisions - 1)
  expect(snapshot.outsideLinks).toEqual([])
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
    const nodes = spec.nodes as { id: string, lane: string, col: number, yOffset: number }[]
    const rows = Math.ceil(revisions / 3)
    expect(spec.lanes).toHaveLength(rows)
    expect(nodes).toHaveLength(snapshot.nodes.length)
    expect(Math.max(...nodes.map(node => node.col))).toBeLessThanOrEqual(5)
    for (const [index, node] of nodes.entries()) {
      const logical = snapshot.nodes[index]
      const row = Math.floor(logical.column / 6)
      expect(node).toMatchObject({ id: logical.id, col: logical.column % 6, lane: row === 0 ? 'research' : 'research_' + row, yOffset: -168 + logical.slot * 112 })
    }
    const byId = new Map(nodes.map(node => [node.id, node]))
    const crossRow = snapshot.edges.filter(edge => byId.get(edge.from)!.lane !== byId.get(edge.to)!.lane)
    expect(crossRow).toHaveLength(rows - 1)
    expect(crossRow.every(edge => edge.kind === (causal ? 'informs-plan' : 'revises-plan'))).toBe(true)
    for (const edge of snapshot.edges.filter(edge => edge.kind === 'uses-plan')) {
      expect(byId.get(edge.from)!.lane).toBe(byId.get(edge.to)!.lane)
      expect(byId.get(edge.to)!.col).toBe(byId.get(edge.from)!.col + 1)
    }
    const result = await service.renderWorkflow({ spec, theme: 'light', locale })
    expectCanvasGeometry(result.svg, snapshot.nodes.map(node => node.id), snapshot.edges.map(({ id, from, to }) => ({ id, from, to })), rows)
    expect(result.nodeIds).toEqual(snapshot.nodes.map(node => node.id))
    expect(result.html).toContain('data-dsh-archify-viewer="1"')
    expect(result.svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(result.svg).toContain(causal ? '误差促成修订' : '修订3')
    for (let revision = 1; revision <= revisions; revision++) {
      expect(result.svg).toContain((locale === 'en' ? 'Plan v' : '方案 v') + revision)
    }
    if (runs > 0) expect(result.svg).toContain(locale === 'en' ? 'Completed' : '已完成')
    expect(result.specSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(result.engineFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(spec).toMatchObject({ meta: { legend: { mode: 'hidden' } } })
    expect(result.svg).not.toContain('data-legend=""')
  }
  await fiber.dispose()
  await expect(service.renderWorkflow({ spec: researchWorkflow(snapshot, 'en'), theme: 'light', locale: 'en' })).rejects.toMatchObject({ code: 'disposed' })
}, 60000)
