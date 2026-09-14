import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'

const SOURCE = 'dsh-profile-researcher:briefing'
const PARKED_SOURCE = 'dsh-profile-researcher:briefing-parked'
const PROMPT = 'Research context has been loaded for a one-time, context-only briefing. '
  + 'Using only the research context already supplied in this conversation, briefly explain the goal, '
  + 'verified progress, current state and selected plan, unresolved questions, and a recommended next direction. '
  + 'Distinguish recorded facts from suggestions and identify missing context rather than fetching it. '
  + 'This is not a request to begin or resume research. Do not call any tools, inspect files, run code, '
  + 'change plans or research state, make decisions for the user, or start an automatic follow-up. '
  + 'Give one final briefing in the user’s language, then wait for an explicit user request.'
const TOOL_DIAGNOSTIC = 'Research briefing stopped: this context-only load does not allow tool calls. '
  + 'No requested tool was executed. Send a separate request to authorize further work.'

interface Briefing {
  readonly message: UserMessage
  readonly initialIds: ReadonlySet<MessageId>
  readonly parkedIds: Set<MessageId>
  parkedMarker?: UserMessage
  turn?: number
  admitted: boolean
  invalid: boolean
  violation: boolean
}

function isBriefing(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === SOURCE
}

function isParked(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === PARKED_SOURCE
}

/**
 * One-shot, tool-free briefing reservations for live agents. The caller must
 * inject research context first and synchronously queue the briefing while the
 * agent is idle, with no queued follow-up and with automatic Goal driving disarmed.
 * Reservations are process-local: persisted canceled/resumed briefings never replay.
 */
export class ResearchBriefings {
  private readonly reservations = new Map<Agent, Briefing>()
  private readonly moving = new WeakMap<Agent, Set<MessageId>>()
  private stopping = false

  /** Install scoped-capable Host hooks; the Context owns their complete teardown. */
  constructor(private readonly ctx: Context) {
    const owner = this
    ctx.effect(function* () {
      ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        // Assembly precedes pre-step admission, including its awaits and retries.
        const reserved = context.agent !== undefined && owner.reservations.has(context.agent)
        const assembly = await next()
        return reserved ? { ...assembly, tools: [] } : assembly
      }, { prepend: true })

      ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
        const reservation = owner.reservations.get(agent)
        if (reservation?.message.id === message.id) reservation.turn = turn
      })

      ctx.on('agent/inbox/inserted', ({ agent, message }) => {
        const reservation = owner.reservations.get(agent)
        if (reservation === undefined || reservation.initialIds.has(message.id) || isParked(message)) return
        if (message.source.kind === 'goal' || isBriefing(message)) owner.remove(agent, message.id)
        else owner.park(agent, [message])
      })

      ctx.on('agent/inbox/discarded', ({ agent, message }) => {
        const reservation = owner.reservations.get(agent)
        if (reservation?.message.id === message.id) reservation.invalid = true
        if (reservation?.parkedIds.has(message.id) && !owner.moving.get(agent)?.has(message.id)) {
          // cancel() may clear the inbox; it must not discard unrelated job facts.
          owner.park(agent, [message])
        }
      })

      ctx.on('agent/pre-step', async (proposal, next): Promise<PreStepDecision> => {
        const { agent, messages, turn, step, signal } = proposal
        const reservation = owner.reservations.get(agent)
        if (reservation === undefined) return await owner.admitParked(agent, messages, next)
        const deferred = (message: UserMessage) => message.source.kind === 'user'
          || isParked(message) || reservation.parkedIds.has(message.id)
        owner.park(agent, messages.filter(deferred))
        if (reservation.invalid || owner.stopping || signal.aborted) {
          owner.park(agent, messages)
          return { kind: 'reject' }
        }
        if (reservation.violation) {
          owner.park(agent, messages)
          throw new Error(TOOL_DIAGNOSTIC)
        }
        if (reservation.admitted || step !== 1 || reservation.turn !== turn
          || !messages.some(message => message.id === reservation.message.id && isBriefing(message))) {
          owner.park(agent, messages)
          throw new Error('Research briefing stopped after its single model step; automatic continuation is not allowed.')
        }
        let decision: PreStepDecision
        try { decision = await next() } catch (error) { owner.park(agent, messages); throw error }
        if (decision.kind === 'reject') { owner.park(agent, messages); return decision }
        owner.park(agent, decision.messages.filter(deferred))
        if (owner.reservations.get(agent) !== reservation || reservation.invalid || owner.stopping || signal.aborted) {
          owner.park(agent, [...messages, ...decision.messages])
          return { kind: 'reject' }
        }
        if (!decision.messages.some(message => message.id === reservation.message.id && isBriefing(message))) {
          owner.park(agent, [...messages, ...decision.messages])
          throw new Error('Research briefing admission failed: its reserved context-only message was removed.')
        }
        reservation.admitted = true
        return {
          ...decision,
          messages: decision.messages.filter(message => !deferred(message) && message.source.kind !== 'goal'),
        }
      }, { prepend: true })

      ctx.on('tools/pre-execute', async (execution, next) => {
        const reservation = execution.agent === undefined ? undefined : owner.reservations.get(execution.agent)
        if (reservation === undefined) return await next()
        reservation.violation = true
        return { kind: 'deny', reason: TOOL_DIAGNOSTIC }
      }, { prepend: true })

      ctx.on('session/event', (session, event) => {
        for (const [agent, reservation] of owner.reservations) {
          if (agent.session !== session || reservation.turn === undefined) continue
          if (event.type === 'assistant/message' && event.data.turn === reservation.turn
            && event.data.message.content.some(block => block.type === 'tool-call')) {
            // Unknown/invalid tools can fail before tools/pre-execute is reached.
            reservation.violation = true
          }
          if (event.type === 'turn/end' && event.data.turn === reservation.turn) {
            // Session publication forbids reentrant appends. This microtask runs
            // before the async turn driver admits its next turn.
            queueMicrotask(() => {
              if (owner.reservations.get(agent) === reservation) owner.retire(agent)
            })
          }
        }
      })

      ctx.on('agent/status', ({ agent, status }) => {
        if (status === 'idle') owner.retire(agent)
      })
      ctx.on('agent/session-start', ({ agent }) => { owner.retire(agent) })
      ctx.on('agent/disposed', ({ agent }) => { owner.retire(agent) })
      ctx.on('agent/error', ({ agent }) => {
        const reservation = owner.reservations.get(agent)
        if (reservation !== undefined) reservation.invalid = true
      })

      // A newly loaded producer must not inherit queued authority from an old one.
      for (const agent of ctx.agents.list()) owner.retire(agent)

      // Hold the fences until canceled streams settle, then dispose all hooks.
      yield async () => {
        owner.stopping = true
        const waits: Promise<void>[] = []
        const agents = [...owner.reservations.keys()]
        for (const [agent, reservation] of owner.reservations) {
          reservation.invalid = true
          owner.remove(agent, reservation.message.id)
          agent.cancel({ kind: 'parent' }, { keepInbox: true })
          waits.push(agent.whenIdle())
        }
        await Promise.allSettled(waits)
        for (const agent of agents) owner.retire(agent)
        owner.reservations.clear()
      }
    }, 'researcher context-only briefings')
  }

  /** Whether this exact live agent already has a queued or admitted briefing. */
  busy(agent: Agent): boolean { return this.reservations.has(agent) }

  /** Reserve before waking the loop; callers must not await between context injection and this call. */
  queue(agent: Agent): void {
    if (this.stopping) throw new Error('Research briefing service is disposing.')
    if (this.busy(agent) || this.ctx.agents.get(agent.id) !== agent || agent.status !== 'idle'
      || agent.inbox.nextTurn.length !== 0
      || agent.inbox.nextStep.some(message => message.source.kind === 'user' || message.source.kind === 'goal')) {
      throw new Error('Research briefing requires an idle live agent with no pending user or Goal input.')
    }
    const message = createUserMessage({
      content: [{ type: 'text', text: PROMPT }],
      source: { kind: 'plugin', plugin: SOURCE, form: 'notice', summary: 'Research context-only briefing' },
    })
    const reservation: Briefing = {
      message,
      initialIds: new Set([...agent.inbox.nextStep.map(input => input.id), message.id]),
      parkedIds: new Set(),
      admitted: false,
      invalid: false,
      violation: false,
    }
    this.reservations.set(agent, reservation)
    try {
      agent.followup(message)
    } catch (error) {
      this.retire(agent)
      throw error
    }
  }

  /**
   * Durable parking uses existing inbox messages, not a volatile deferred queue.
   * The marker can cause one rejected empty turn, but never a model request.
   * Original notification identities and sources survive cancellation/restart.
   */
  private park(agent: Agent, messages: readonly UserMessage[]): void {
    const inputs = messages.filter(message => !isBriefing(message) && message.source.kind !== 'goal')
    if (inputs.length === 0) return
    const reservation = this.reservations.get(agent)
    let marker = inputs.find(isParked) ?? [...agent.inbox.nextStep, ...agent.inbox.nextTurn].find(isParked)
      ?? reservation?.parkedMarker
    if (marker === undefined && inputs.some(message => message.source.kind !== 'user')) {
      marker = createUserMessage({
        content: [{ type: 'text', text: 'Background notifications were parked during a context-only research briefing. '
          + 'They are context, not authorization for automatic work. Await the next human request.' }],
        source: { kind: 'plugin', plugin: PARKED_SOURCE, form: 'notice', summary: 'Background notifications deferred' },
      })
    }
    if (reservation !== undefined && marker !== undefined) reservation.parkedMarker = marker
    const pending = [...marker === undefined ? [] : [marker], ...inputs.filter(message => !isParked(message))]
    for (const message of pending) {
      if (message.source.kind !== 'user') reservation?.parkedIds.add(message.id)
      const target = reservation !== undefined || message.source.kind === 'user' ? 'next-turn' : 'next-step'
      const pending = target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep
      if (pending.some(item => item.id === message.id)) continue
      this.remove(agent, message.id)
      agent.inbox.append(target, message)
    }
  }

  private async admitParked(
    agent: Agent, messages: readonly UserMessage[], next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const marked = messages.some(isParked)
    if (!marked && !messages.some(isBriefing)) return await next()
    const human = messages.some(message => message.source.kind === 'user')
    if (!marked || (!human && !messages.some(message => message.source.kind === 'goal'))) {
      // Restore without followup()/steer(): a rejected turn settles idle even
      // with pending input. A later human request will consume the parked facts.
      this.park(agent, messages)
      return { kind: 'reject' }
    }
    let decision: PreStepDecision
    try { decision = await next() } catch (error) { this.park(agent, messages); throw error }
    if (decision.kind === 'reject') { this.park(agent, messages); return decision }
    if (!human) {
      const goal = this.ctx.get('goals')?.get(agent)
      const authorized = decision.startsRequestSeries === true && goal !== undefined
        && goal.phase === 'active' && goal.activation === 'armed'
        && decision.messages.some(message => {
          const source = message.source
          return source.kind === 'goal' && Number.isSafeInteger(source.round) && source.round > 0
            && source.goalId === goal.id && source.revision === goal.revision
            && source.round === goal.roundsStarted + 1 && source.round <= goal.maxGoalRounds
            && messages.some(original => original.id === message.id && original.source.kind === 'goal'
              && original.source.goalId === source.goalId && original.source.revision === source.revision
              && original.source.round === source.round)
        })
      if (!authorized) { this.park(agent, [...messages, ...decision.messages]); return { kind: 'reject' } }
    }
    return { ...decision, messages: decision.messages.filter(message => !isParked(message) && !isBriefing(message)) }
  }

  /** Distinguish our requeues from an external cancel/clear operation. */
  private remove(agent: Agent, id: MessageId): void {
    let moving = this.moving.get(agent)
    if (moving === undefined) { moving = new Set(); this.moving.set(agent, moving) }
    moving.add(id)
    try { agent.inbox.remove(id) } finally { moving.delete(id) }
  }

  private retire(agent: Agent): void {
    this.reservations.delete(agent)
    for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
      if (isBriefing(message)) this.remove(agent, message.id)
    }
    // next-turn claims only one message; next-step claims the whole batch.
    // Move parked facts there only after the brief ends, so they cannot cause
    // its second step, and the next human/validated Goal sees the full batch.
    if ([...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(isParked)) {
      for (const message of [...agent.inbox.nextTurn]) {
        if (message.source.kind === 'user' || message.source.kind === 'goal') continue
        this.remove(agent, message.id)
        agent.inbox.append('next-step', message)
      }
    }
  }
}
