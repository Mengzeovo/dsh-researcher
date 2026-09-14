import { expect, it } from 'vitest'
import { projectResearchView } from '../src/view-projection.ts'
import { researchWorkflow } from '../src/view-workflow.ts'
import { populatedViewFixture, viewConfig, viewRequest, viewToken } from './view-test-helpers.ts'

interface MappedEdge { readonly variant?: string; readonly label?: string }

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
