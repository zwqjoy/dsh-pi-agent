/**
 * Durable inbox for the Pi-driven agent.
 *
 * DSH 0.2 made the inbox an agent-owned facade over durable session events:
 * every mutation is an `agent/inbox/spliced` event, and the pending lists are
 * folded back from that log. The default loop uses a projection registry to
 * read the folded state; this implementation keeps the fold private so the
 * plugin does not depend on the loop's projection registration, while still
 * writing the exact event shape the frontend and projections expect.
 */

import type { MessageId } from '@deepseek-ai/dsh-llm'
import type {
  AgentEventDispatch,
  Inbox as InboxContract,
  InboxState,
  InboxTarget,
} from '@deepseek-ai/dsh-agent'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'

/** Empty fold state; both lists are ordered oldest-first. */
function emptyState(): InboxState {
  return { 'next-turn': [], 'next-step': [] }
}

/** Apply one durable splice exactly like the standard inbox projection. */
function foldSplice(state: InboxState, event: { target: InboxTarget; start: number; removedCount?: number; inserted: readonly UserMessage[] }): InboxState {
  const current = [...state[event.target]]
  current.splice(event.start, event.removedCount ?? 0, ...event.inserted)
  return event.target === 'next-turn'
    ? { 'next-turn': current, 'next-step': state['next-step'] }
    : { 'next-turn': state['next-turn'], 'next-step': current }
}

export class PiInbox implements InboxContract {
  private state: InboxState = emptyState()

  constructor(
    private readonly session: Session,
    private readonly dispatch: AgentEventDispatch,
  ) {
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'agent/inbox/spliced') continue
      this.state = foldSplice(this.state, event.data)
    }
  }

  get nextTurn(): readonly UserMessage[] {
    return this.state['next-turn']
  }

  get nextStep(): readonly UserMessage[] {
    return this.state['next-step']
  }

  /** Whether either pending list still holds work (driver drain check). */
  get hasPending(): boolean {
    return this.state['next-turn'].length > 0 || this.state['next-step'].length > 0
  }

  clear(): void {
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  /**
   * Remove and return the batch claimed for one turn: all pending steering,
   * plus the single queued turn when requested.
   */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
    if (target === 'next-turn') claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    for (const message of claimed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return claimed
  }

  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.state[target].length, 0, [message])
  }

  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [newMessage])
    return true
  }

  remove(messageId: MessageId): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

  splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = this.state[target].findIndex((message) => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /** Commit one normalized mutation and publish its live events. */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): UserMessage[] {
    const inbox = this.state[target]
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart = offset < 0 ? Math.max(inbox.length + offset, 0) : Math.min(offset, inbox.length)
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0), inbox.length - actualStart)
    if (actualDeleteCount === 0 && inserted.length === 0) return []

    const candidate = [...inbox]
    candidate.splice(actualStart, actualDeleteCount, ...inserted)
    const ids = new Set<string>()
    for (const message of [...candidate, ...this.state[target === 'next-turn' ? 'next-step' : 'next-turn']]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }

    const removed = inbox.slice(actualStart, actualStart + actualDeleteCount)
    const event = this.session.append('agent/inbox/spliced', {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(discardRemoved && actualDeleteCount > 0 ? { outcome: 'canceled' as const } : {}),
    })
    this.state = foldSplice(this.state, event.data)

    if (discardRemoved) for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
    for (const message of event.data.inserted) this.dispatch.emit('agent/inbox/inserted', { message })
    return removed
  }
}
