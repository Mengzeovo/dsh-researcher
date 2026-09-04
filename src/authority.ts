import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { markerResearchId } from './context.ts'
import { ResearcherError } from './errors.ts'
import type { ResearchId } from './types.ts'

export interface ResearchToolExecution {
  readonly agent: Agent
  readonly events: readonly SessionEvent[]
  readonly openTurnStartSeq: number
}

function reject(message: string, code: 'RESEARCH_AUTHORITY_REQUIRED' | 'RESEARCH_DRIVER_REQUIRED'): never {
  throw new ResearcherError(message, code)
}

function openTurnEvents(ctx: Context, agent: Agent): Pick<ResearchToolExecution, 'events' | 'openTurnStartSeq'> {
  const events = agent.session.events
  const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
  if (boundary === undefined || boundary.openTurnStartSeq === null) {
    reject('researcher tools require an open model turn', 'RESEARCH_DRIVER_REQUIRED')
  }
  return { events, openTurnStartSeq: boundary.openTurnStartSeq }
}

export function researchToolExecution(ctx: Context, exec: ToolRunContext): ResearchToolExecution {
  const agent = exec.agent
  if (agent === undefined) reject('researcher tools require a calling agent', 'RESEARCH_DRIVER_REQUIRED')
  if (ctx.agents.get(agent.id) !== agent
    || agent.status !== 'running'
    || ctx.agents.currentInitiator() !== agent) {
    reject('researcher tools require the exact live calling agent inside its active driver', 'RESEARCH_DRIVER_REQUIRED')
  }
  return { agent, ...openTurnEvents(ctx, agent) }
}

function someOpenTurnEvent(
  execution: ResearchToolExecution,
  predicate: (event: SessionEvent) => boolean,
): boolean {
  for (let seq = execution.openTurnStartSeq + 1; seq < execution.events.length; seq += 1) {
    const event = execution.events[seq]
    if (event !== undefined && predicate(event)) return true
  }
  return false
}

function hasDirectHumanInput(ctx: Context, execution: ResearchToolExecution): boolean {
  if (!ctx.agents.roots().includes(execution.agent)) return false
  return someOpenTurnEvent(execution, event =>
    event.type === 'user/message' && event.data.source.kind === 'user')
}

function isMatchingGoalRound(execution: ResearchToolExecution, goal: GoalView, id: ResearchId): boolean {
  if (markerResearchId(goal.objective) !== id) return false
  return someOpenTurnEvent(execution, event => event.type === 'user/message'
    && event.data.source.kind === 'goal'
    && event.data.source.goalId === goal.id
    && event.data.source.revision === goal.revision
    && event.data.source.round === goal.roundsStarted)
}

export function requireDirectHuman(ctx: Context, execution: ResearchToolExecution): void {
  if (hasDirectHumanInput(ctx, execution)) return
  reject('creating a research target requires a direct human turn on a top-level agent', 'RESEARCH_AUTHORITY_REQUIRED')
}

export function requireResearchMutation(
  ctx: Context,
  execution: ResearchToolExecution,
  id: ResearchId,
): void {
  if (hasDirectHumanInput(ctx, execution)) return
  const goal = ctx.goals.get(execution.agent)
  if (goal !== undefined && isMatchingGoalRound(execution, goal, id)) return
  reject(
    'research mutations require a direct human turn or the exact current Goal Round for the loaded research target',
    'RESEARCH_AUTHORITY_REQUIRED',
  )
}
