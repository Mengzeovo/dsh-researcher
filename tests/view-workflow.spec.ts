import { expect, it } from 'vitest'
import { projectResearchView } from '../src/view-projection.ts'
import { researchWorkflow } from '../src/view-workflow.ts'
import { populatedViewFixture, viewConfig, viewRequest, viewToken } from './view-test-helpers.ts'

interface MappedEdge { readonly variant?: string; readonly label?: string }
interface MappedNode { readonly id: string; readonly lane: string; readonly col: number; readonly yOffset: number; readonly label: string; readonly sublabel: string }

it.each([1, 3, 4, 6, 7])('wraps %i revisions into six-column rows without splitting plan/Run pairs or losing edges', async versions => {
  const f = await populatedViewFixture(versions, 1)
  const { snapshot } = projectResearchView(await f.read(), viewToken, viewRequest(), viewConfig)
  const spec = researchWorkflow(snapshot, 'en')
  const nodes = spec.nodes as unknown as readonly MappedNode[]
  const lanes = spec.lanes as unknown as readonly { id: string }[]
  expect(lanes).toHaveLength(Math.ceil(versions / 3))
  expect(nodes).toHaveLength(versions * 2)
  for (let index = 0; index < versions; index++) {
    const plan = nodes.find(node => node.id === 'plan_1_v' + (index + 1))!
    const run = nodes.find(node => node.id === 'run_' + f.runs[index]![0])!
    expect(plan.lane).toBe(lanes[Math.floor(index / 3)]!.id)
    expect(plan.col).toBe((index % 3) * 2)
    expect(run).toMatchObject({ lane: plan.lane, col: plan.col + 1 })
  }
  expect(nodes.every(node => node.col >= 0 && node.col < 6)).toBe(true)
  expect((spec.edges as unknown as readonly { id: string }[]).map(edge => edge.id)).toEqual(snapshot.edges.map(edge => edge.id))
}, 60000)

it('names experiments with their authored purpose, hides IDs, and retains full arrow text in the snapshot', async () => {
  const f = await populatedViewFixture(2, 1, true)
  const { snapshot } = projectResearchView(await f.read(), viewToken, viewRequest(), viewConfig)
  const graph = { ...snapshot, nodes: snapshot.nodes.map(node => node.kind === 'run' ? { ...node, title: '轮次测试' } : node),
    edges: snapshot.edges.map(edge => edge.kind === 'informs-plan' ? { ...edge, label: '**完整依据**\n\n这里是超过箭头预览长度的最终结论。' } : edge) }
  for (const locale of ['en', 'zh-CN'] as const) {
    const spec = researchWorkflow(graph, locale)
    const nodes = spec.nodes as unknown as readonly MappedNode[]
    for (const run of graph.nodes.filter(node => node.kind === 'run')) {
      const mapped = nodes.find(node => node.id === run.id)!
      expect(mapped.label).toBe(locale === 'en' ? 'Experiment 轮次测试' : '实验 轮次测试')
      expect(mapped.label + mapped.sublabel).not.toContain(run.runId.slice(0, 6))
    }
    expect((spec.edges as unknown as readonly MappedEdge[]).find(edge => edge.variant === 'emphasis')?.label).not.toContain('最终结论')
  }
  expect(graph.edges.find(edge => edge.kind === 'informs-plan')?.label).toContain('最终结论')
  const long = researchWorkflow({ ...graph, nodes: graph.nodes.map(node => node.kind === 'run' ? { ...node, title: '很长的实验名称'.repeat(30) } : node) }, 'zh-CN')
  expect((long.nodes as unknown as readonly MappedNode[]).find(node => node.id.startsWith('run_'))?.label).toMatch(/^实验 .+…$/u)
}, 60000)

it('keeps evidence edges emphasized and maps discussion-driven lineage to dashed labeled links', async () => {
  const causal = await populatedViewFixture(3, 1, true)
  const causalEdges = researchWorkflow(projectResearchView(await causal.read(), viewToken, viewRequest(), viewConfig).snapshot, 'zh-CN')
    .edges as unknown as readonly MappedEdge[]
  expect(causalEdges.filter(edge => edge.variant === 'emphasis')).toHaveLength(2)
  expect(causalEdges.every(edge => edge.variant !== 'dashed')).toBe(true)

  const discussed = await populatedViewFixture(3, 1, false)
  const edges = researchWorkflow(projectResearchView(await discussed.read(), viewToken, viewRequest(), viewConfig).snapshot, 'zh-CN')
    .edges as unknown as readonly MappedEdge[]
  expect(edges.filter(edge => edge.variant === undefined)).toHaveLength(3)
  expect(edges.filter(edge => edge.variant === 'dashed').map(edge => ({ label: edge.label, variant: edge.variant }))).toEqual([
    { label: '修订1', variant: 'dashed' },
    { label: '修订2', variant: 'dashed' },
  ])
}, 60000)
