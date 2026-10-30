/**
 * PiAgent — a DSH `Agent` implementation whose driver is the Pi coding agent
 * loop running headless in a child process (`pi --mode rpc`).
 *
 * DSH's frontend, session log, and hooks program against the `Agent`
 * interface (`@deepseek-ai/dsh-agent`); this class satisfies that contract and
 * translates Pi's RPC event stream into DSH's durable session events
 * (`turn/*`, `step/*`, `user/message`, `assistant/message`, `tool/call`,
 * `tool/result`) plus live `agent/assistant-stream` frames.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import {
  agentEvents,
  type Agent,
  type AgentEventDispatch,
  type AgentOptions,
  type AgentStatus,
} from '@deepseek-ai/dsh-agent'
import {
  AssistantStreamAccumulator,
  LlmAttemptId,
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  type AssistantMessage,
  type AssistantStreamRecord,
  type ContentBlock,
  type StreamChunk,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  AgentCancelCause,
  Session,
  SessionId,
  SessionSeq,
  TurnEndReason,
} from '@deepseek-ai/dsh-session'
import { PiInbox } from './inbox.ts'
import { PiRpcClient, type PiEvent } from './rpc-client.ts'

export interface PiAgentOptions {
  /** Base context whose dependency API the agent's own scope inherits. */
  ctx: Context
  session: Session
  agentOptions: AgentOptions
  rpc: PiRpcClient
  /** Working directory reported on the session header. */
  cwd: string
}

/** Map a Pi assistant content block to a DSH content block. */
function convertBlock(block: unknown): ContentBlock | undefined {
  if (!block || typeof block !== 'object') return undefined
  const record = block as { type?: string }
  switch (record.type) {
    case 'text': {
      const text = (block as { text?: unknown }).text
      return { type: 'text', text: typeof text === 'string' ? text : '' }
    }
    case 'thinking': {
      const thinking = (block as { thinking?: unknown }).thinking
      return { type: 'reasoning', text: typeof thinking === 'string' ? thinking : '' }
    }
    case 'toolCall': {
      const tool = block as { id?: unknown; name?: unknown; arguments?: unknown }
      const args = tool.arguments
      return {
        type: 'tool-call',
        id: ToolCallId(String(tool.id ?? '')),
        name: String(tool.name ?? ''),
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      }
    }
    default:
      return undefined
  }
}

/** Extract the text payload of a DSH UserMessage for the Pi prompt command. */
function extractDshText(message: UserMessage): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

/** Per-step live stream bookkeeping for one Pi run attempt. */
interface StreamAttempt {
  readonly id: LlmAttemptId
  readonly revision: number
  index: number
  committed: boolean
}

export class PiAgent implements Agent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session
  readonly inbox: PiInbox
  readonly ctx: Context

  private readonly rpc: PiRpcClient
  private readonly cwd: string
  private readonly scope: Scope
  private readonly dispatch: AgentEventDispatch
  private readonly disposeScope: () => Promise<void> | void
  private readonly unwatch: () => void

  private _status: AgentStatus = 'idle'
  private readonly pendingIdle: (() => void)[] = []
  private driver: Promise<void> | null = null
  private turn = 0
  private step = 0
  private stepOpen = false
  private firstAssistant = true
  private aborted = false
  private settleResolvers: (() => void)[] = []
  private piError: Error | null = null
  private attemptCounter = 0
  private attempt: StreamAttempt | null = null
  private stream = new AssistantStreamAccumulator()
  private readonly toolCallSeqs = new Map<string, SessionSeq>()
  private currentProvider = ''
  private currentModel = ''

  constructor(options: PiAgentOptions) {
    this.rpc = options.rpc
    this.cwd = options.cwd
    this.id = options.session.id
    this.options = options.agentOptions
    this.session = options.session
    // DSH contract: each Agent owns a scope keyed by ITSELF (an object — the
    // scope key feeds WeakMaps downstream). The fused dispatcher is built
    // before the inbox because inbox notifications dispatch through it.
    this.dispatch = agentEvents(options.ctx, this)
    this.scope = createScope(options.ctx, this)
    this.ctx = this.scope.ctx
    this.disposeScope = () => void this.scope.dispose()
    this.inbox = new PiInbox(options.session, this.dispatch)
    this.unwatch = this.rpc.onEvent((event) => this.onPiEvent(event))
    this.emitStatus('idle')
  }

  get status(): AgentStatus {
    return this._status
  }

  private setStatus(status: AgentStatus): void {
    if (this._status === status) return
    this._status = status
    this.emitStatus(status)
  }

  private emitStatus(status: AgentStatus): void {
    this.dispatch.emit('agent/status', { status })
  }

  // ---- Agent interface: message intake ----

  send(message: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean): void {
    this.inbox.append(target, message)
    if (wakeup) void this.drive()
  }

  followup(message: UserMessage): void {
    this.inbox.append('next-turn', message)
    void this.drive()
  }

  steer(message: UserMessage): void {
    this.inbox.append('next-step', message)
    // Pi supports interrupting a live run with its `steer` command; when idle
    // the next prompt carries the message.
    if (this.rpc.running && this._status === 'running') {
      void this.rpc.send({ type: 'steer', message: extractDshText(message) }).catch(() => undefined)
    } else {
      void this.drive()
    }
  }

  inject(message: UserMessage): void {
    this.inbox.append('next-step', message)
  }

  cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void {
    if (!options?.keepInbox) this.inbox.clear()
    this.aborted = true
    void this.rpc.abort().catch(() => undefined)
  }

  whenIdle(): Promise<void> {
    if (this.driver === null) return Promise.resolve()
    return this.driver.then(() => undefined)
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    return task(controller.signal)
  }

  // ---- Driver ----

  private drive(): void {
    if (this.driver !== null) return
    this.driver = this.runDriver().finally(() => {
      this.driver = null
      this.setStatus('idle')
      const waiters = this.pendingIdle.splice(0)
      for (const resolve of waiters) resolve()
    })
    void this.driver
  }

  private async runDriver(): Promise<void> {
    while (!this.aborted) {
      if (this.inbox.nextTurn.length === 0) break
      await this.runTurn()
    }
    this.aborted = false
  }

  private async runTurn(): Promise<void> {
    this.setStatus('running')
    this.turn += 1
    this.step = 0
    this.firstAssistant = true
    this.aborted = false
    this.piError = null
    const turn = this.turn
    let endReason: TurnEndReason = { kind: 'completed' }
    try {
      this.session.append('turn/start', { turn })
      // Claim all pending steering plus exactly one queued turn. The batch is
      // what this turn admits, in inbox order.
      const claimed = this.inbox.claim('next-turn', turn)
      if (claimed.length === 0) return
      this.openStep()
      for (const message of claimed) this.session.append('user/message', message, { surfaceOp: 'append' })
      const promptText = claimed.map((message) => extractDshText(message)).join('\n')
      await this.rpc.prompt(promptText)
      // Wait until Pi reports the run settled.
      await this.waitSettled()
      // A model/transport failure settles with an empty assistant message;
      // surface it as the turn's failure instead of a silent "completed".
      if (this.piError !== null) {
        const failure = this.piError
        this.piError = null
        throw failure
      }
    } catch (error: unknown) {
      endReason = this.aborted
        ? { kind: 'aborted', reason: { kind: 'user' } }
        : { kind: 'error', error: { message: String(error), code: 'UNKNOWN' } }
    } finally {
      this.closeStep()
      try {
        this.session.append('turn/end', { turn, reason: endReason })
      } catch (error: unknown) {
        this.dispatch.emit('agent/error', { turn, step: this.step, error })
      }
    }
  }

  private waitSettled(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.settleResolvers.push(resolve)
    })
  }

  private openStep(): void {
    if (this.stepOpen) return
    this.step += 1
    this.stepOpen = true
    this.session.append('step/start', { turn: this.turn, step: this.step })
    this.stream = new AssistantStreamAccumulator()
    this.attempt = {
      id: LlmAttemptId(`pi-${String(this.id)}-${this.turn}-${this.step}-${++this.attemptCounter}`),
      revision: 1,
      index: 0,
      committed: false,
    }
    this.dispatch.emit('agent/assistant-stream', {
      frame: {
        type: 'start',
        attemptId: this.attempt.id,
        revision: this.attempt.revision,
        turn: this.turn,
        step: this.step,
      },
    })
  }

  private closeStep(): void {
    if (!this.stepOpen) return
    const attempt = this.attempt
    if (attempt !== null && !attempt.committed) {
      this.dispatch.emit('agent/assistant-stream', {
        frame: {
          type: 'end',
          attemptId: attempt.id,
          revision: attempt.revision,
          index: attempt.index,
          outcome: { kind: 'abandoned' },
        },
      })
    }
    this.attempt = null
    this.stepOpen = false
    this.session.append('step/end', { turn: this.turn, step: this.step })
  }

  // ---- Pi event translation ----

  private onPiEvent(event: PiEvent): void {
    switch (event.type) {
      case 'message_start': {
        const message = event.message as { role?: string } | undefined
        if (message?.role !== 'assistant') return
        if (this.firstAssistant) {
          this.firstAssistant = false
          return
        }
        // A further assistant message means Pi looped through tools: close the
        // previous step and open a fresh one.
        this.closeStep()
        this.openStep()
        return
      }
      case 'message_update': {
        const assistantEvent = event.assistantMessageEvent as
          | { type: string; contentIndex?: number; delta?: string; text?: string; toolCall?: { id?: string; name?: string } }
          | undefined
        if (!assistantEvent) return
        const index = assistantEvent.contentIndex ?? 0
        this.openStep()
        switch (assistantEvent.type) {
          case 'text_delta': {
            this.appendChunk({ type: 'text-delta', index, text: assistantEvent.delta ?? assistantEvent.text ?? '' })
            return
          }
          case 'thinking_delta': {
            this.appendChunk({ type: 'reasoning-delta', index, text: assistantEvent.delta ?? assistantEvent.text ?? '' })
            return
          }
          case 'toolcall_delta': {
            const tool = assistantEvent.toolCall
            this.appendChunk({
              type: 'tool-call-delta',
              index,
              id: ToolCallId(String(tool?.id ?? '')),
              ...(tool?.name !== undefined ? { name: tool.name } : {}),
              argumentsDelta: assistantEvent.delta ?? '',
            })
            return
          }
          default:
            return
        }
      }
      case 'message_end': {
        const message = event.message as
          | { role?: string; content?: unknown; provider?: string; model?: string; stopReason?: string; errorMessage?: string }
          | undefined
        if (message?.role !== 'assistant') return
        const content = Array.isArray(message.content) ? message.content : []
        const blocks = content.map(convertBlock).filter((block): block is ContentBlock => block !== undefined)
        if (blocks.length === 0) {
          if (message.stopReason === 'error') {
            this.piError = new Error(String(message.errorMessage ?? 'pi model request failed'))
          }
          return
        }
        const sourceProvider = typeof message.provider === 'string' ? message.provider : this.options.provider ?? ''
        const sourceModel = typeof message.model === 'string' ? message.model : this.options.model ?? ''
        this.currentProvider = sourceProvider
        this.currentModel = sourceModel
        this.openStep()
        const stream: AssistantStreamRecord[] = [...this.stream.snapshot()]
        const settled = this.session.append(
          'assistant/message',
          {
            turn: this.turn,
            step: this.step,
            message: createAssistantMessage({
              content: blocks,
              source: { provider: sourceProvider, model: sourceModel },
            }),
            stream,
          },
          { surfaceOp: 'append' },
        )
        const attempt = this.attempt
        if (attempt !== null) {
          attempt.committed = true
          this.dispatch.emit('agent/assistant-stream', {
            frame: {
              type: 'end',
              attemptId: attempt.id,
              revision: attempt.revision,
              index: attempt.index,
              outcome: { kind: 'committed', eventType: 'assistant/message', seq: settled.seq },
            },
          })
          this.attempt = null
        }
        return
      }
      case 'tool_execution_start': {
        const start = event as { toolCallId?: unknown; toolName?: unknown; args?: unknown }
        const callId = ToolCallId(String(start.toolCallId ?? ''))
        const name = String(start.toolName ?? '')
        const args = start.args
        const argumentsText = typeof args === 'string' ? args : JSON.stringify(args ?? {})
        const callEvent = this.session.append('tool/call', { turn: this.turn, step: this.step, callId, name, arguments: argumentsText })
        this.toolCallSeqs.set(String(callId), callEvent.seq)
        return
      }
      case 'tool_execution_end': {
        const end = event as { toolCallId?: unknown; toolName?: unknown; result?: unknown; isError?: boolean }
        const callId = ToolCallId(String(end.toolCallId ?? ''))
        const resultText = typeof end.result === 'string'
          ? end.result
          : JSON.stringify(end.result ?? '')
        const isError = end.isError === true
        const message = createToolResultMessage({
          callId,
          content: [{ type: 'text', text: resultText }],
          isError,
        })
        const callSeq = this.toolCallSeqs.get(String(callId))
        this.session.append(
          'tool/result',
          { turn: this.turn, step: this.step, message },
          { surfaceOp: 'append', ...(callSeq !== undefined ? { sourceEventSeqs: [callSeq] } : {}) },
        )
        return
      }
      case 'agent_settled':
      case 'agent_end': {
        // The run is finished; settle waiters in case `agent_settled` was missed.
        const resolvers = this.settleResolvers.splice(0)
        for (const resolve of resolvers) resolve()
        return
      }
      default:
        return
    }
  }

  private appendChunk(chunk: StreamChunk): void {
    this.openStep()
    const attempt = this.attempt
    if (attempt === null) return
    const timed = this.stream.push({ time: Date.now(), chunk })
    this.dispatch.emit('agent/assistant-stream', {
      frame: {
        type: 'chunk',
        attemptId: attempt.id,
        revision: attempt.revision,
        index: attempt.index++,
        time: timed.time,
        chunk: timed.chunk,
      },
    })
  }

  /** Tear down: stop Pi and unwind the scoped context. */
  dispose(): void {
    this.unwatch()
    this.rpc.close()
    void this.disposeScope()
  }
}

/** Create a PiAgent instance plus its owning scope and session. */
export function createPiAgent(options: {
  ctx: Context
  session: Session
  agentOptions: AgentOptions
  rpc: PiRpcClient
  cwd: string
}): PiAgent {
  return new PiAgent(options)
}
