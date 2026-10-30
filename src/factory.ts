/**
 * PiAgentFactory — the `AgentFactory` (`ctx.agents.setFactory`) that turns
 * DSH's frontend into a client for the Pi coding agent loop.
 *
 * When this plugin is loaded, every new session the frontend creates is
 * driven by a Pi child process (`pi --mode rpc`) instead of DSH's own
 * `dsh-agent-loop`. The factory prepares the session, builds the scoped
 * PiAgent and the RPC child, takes persistence write ownership, and then
 * publishes both through the same ordered boundary the default loop uses
 * (`session/created`, `agent/created`, `agent/session-start`), so DSH's
 * frontend, hooks, and session log work unchanged.
 *
 * To fall back to DSH's own loop, disable this plugin's entry (or the
 * profile patch inserting it) — the default `agent-loop` factory remains
 * registered underneath and becomes active again.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentFactory,
  AgentHandle,
  AgentOptions,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import {
  SessionLogOffset,
  type Session,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { buildPiSessionFile } from './history.ts'
import { PiAgent } from './pi-agent.ts'
import { PiRpcClient } from './rpc-client.ts'

/**
 * Minimal structural view of the persistence service and its write handle.
 * Kept local so the plugin does not need a hard type dependency on the
 * backend package; both members are stable public contracts.
 */
interface PersistenceHandleLike {
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{
    readonly events: readonly SessionEvent[]
    readonly eventState: 'detached' | 'shared-frozen'
  }>
  append(events: readonly SessionEvent[], options?: { signal?: AbortSignal }): Promise<void>
  close(): Promise<void>
}

interface SessionPersistenceLike {
  create(header: SessionHeader, options?: { inheritedEventCount?: SessionLogOffset; signal?: AbortSignal }): Promise<PersistenceHandleLike>
  open(id: SessionId, access: 'write', options?: { signal?: AbortSignal }): Promise<PersistenceHandleLike>
}

export interface PiFactoryOptions {
  /** Absolute path to the Pi executable (defaults to `pi` on PATH). */
  piPath?: string
  /** Working directory for Pi sessions (defaults to process.cwd()). */
  cwd: string
  /** Pi model route (`provider/model`, e.g. `anthropic/claude-sonnet-4-5`). */
  model?: string
  /** Pi-known route used when the DSH-selected model is unknown to pi. */
  modelFallback?: string
  /** Diagnostics sink; omit to keep quiet. */
  logger?: (line: string) => void
  /** Lifecycle trace sink (apply/createAgent/resume); omit to keep quiet. */
  trace?: (line: string) => void
}

export class PiAgentFactory implements AgentFactory {
  private readonly registryCtx: Context

  constructor(
    private readonly options: PiFactoryOptions,
    registryCtx: Context,
  ) {
    this.registryCtx = registryCtx
  }

  private persistence(): SessionPersistenceLike | undefined {
    return this.registryCtx.get('sessionPersistence') as SessionPersistenceLike | undefined
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const id = options.sessionId
    this.options.trace?.(`createAgent id=${String(id)} meta=${JSON.stringify(options.meta)}`)
    const cwd = options.meta?.cwd ?? this.options.cwd
    try {
      const session = this.registryCtx.sessions.prepare(id, {
        ...options.seed === undefined ? {} : { seed: options.seed },
        ...options.meta === undefined ? {} : { meta: options.meta },
        ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
      })
      const persistence = this.persistence()
      let handle: PersistenceHandleLike | undefined
      try {
        handle = persistence === undefined
          ? undefined
          : await persistence.create(session.header, {
              inheritedEventCount: session.inheritedEventCount,
              ...options.signal === undefined ? {} : { signal: options.signal },
            })
      } catch (error: unknown) {
        await handle?.close().catch(() => undefined)
        throw error
      }
      const handleFinal = await this.assembleAndPublish(
        ownerCtx, id, session, cwd, options.agentOptions, options.signal, options.setup, 'startup', options.parentAgent, handle, 0,
      )
      this.options.trace?.(`createAgent OK id=${String(id)}`)
      return handleFinal
    } catch (error: unknown) {
      this.options.trace?.(`createAgent FAILED id=${String(id)}: ${String(error)}`)
      throw error
    }
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.persistence()
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    const id = options.resumeSessionId
    this.options.trace?.(`resume id=${String(id)}`)
    let handle: PersistenceHandleLike | undefined
    try {
      handle = await persistence.open(id, 'write', {
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      const stored = await handle.read(0, undefined, {
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      const session = this.registryCtx.sessions.prepare(id, {
        seed: [...stored.events],
        meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount,
        eventState: stored.eventState,
      })
      const cwd = session.header.cwd ?? this.options.cwd
      const published = await this.assembleAndPublish(
        ownerCtx, id, session, cwd, options.agentOptions, options.signal, options.setup, 'resume', options.parentAgent, handle, stored.events.length,
      )
      this.options.trace?.(`resume OK id=${String(id)}`)
      return published
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined)
      this.options.trace?.(`resume FAILED id=${String(id)}: ${String(error)}`)
      throw error
    }
  }

  /** Mint the Pi RPC child, build the scoped PiAgent, and publish the pair. */
  private async assembleAndPublish(
    ownerCtx: Context,
    id: SessionId,
    session: Session,
    cwd: string,
    agentOptions: AgentOptions | undefined,
    signal: AbortSignal | undefined,
    setup: CreateAgentOptions['setup'],
    source: 'startup' | 'resume',
    parentAgent: CreateAgentOptions['parentAgent'],
    handle: PersistenceHandleLike | undefined,
    storedCount: number,
  ): Promise<AgentHandle> {
    ownerCtx.fiber.assertActive()
    if (signal?.aborted) throw new Error(`agent "${id}" creation aborted`)

    // The requested per-agent model route wins over the factory default. This
    // is what lets a delegated child (whose `agentOptions` come from
    // tool-subagent's config) run on a fixed model like `provider/model`
    // while the top-level session keeps the factory default.
    const requested = agentOptions
    const model = requested?.model !== undefined && requested.model !== ''
      ? `${requested.provider ?? ''}/${requested.model}`.replace(/^\/+/, '')
      : this.options.model ?? ''
    let effectiveModel = model
    let provider = model.split('/')[0] ?? ''
    let modelId = model.split('/').slice(1).join('/')

    // Rebuild the Pi session from DSH's durable log: the child inherits the
    // complete conversation (DSH-native turns and earlier Pi turns alike), so
    // a session handed off mid-stream continues with full context.
    const sessionFile = buildPiSessionFile({
      session,
      cwd,
      filePath: join(homedir(), '.dsh', 'pi-sessions', `${String(id).replace(/[^\w-]/g, '_')}.jsonl`),
      logger: this.options.logger,
    })
    const rpc = new PiRpcClient({
      cwd,
      piPath: this.options.piPath,
      sessionFile,
      logger: this.options.logger,
    })
    // Validate the DSH-selected route against pi's own model catalog before
    // publishing. DSH and pi keep separate catalogs; an unknown route used to
    // fail deep inside pi with an opaque error (and hid the real cause from
    // the session error). Fail at creation with the routes pi can actually run.
    if (model !== '') {
      try {
        const available = await rpc.availableModels()
        let known = available.some((entry) => entry.provider === provider && entry.id === modelId)
        if (!known) {
          const fallback = this.options.modelFallback ?? ''
          const fallbackProvider = fallback.split('/')[0] ?? ''
          const fallbackId = fallback.split('/').slice(1).join('/')
          const fallbackKnown = fallback !== ''
            && available.some((entry) => entry.provider === fallbackProvider && entry.id === fallbackId)
          if (!fallbackKnown) {
            const routes = available.slice(0, 8).map((entry) => `${entry.provider}/${entry.id}`).join(', ')
            throw new Error(
              `pi 不认识模型 "${model}"。pi 可用的模型: ${routes === '' ? '(none)' : routes}。`
              + `请在 DSH 里选择 pi 支持的模型、配置 modelFallback，或把该 provider 加入 pi 的模型配置（~/.pi/agent/models.json）。`,
            )
          }
          this.options.logger?.(`[pi:model] DSH model "${model}" is unknown to pi; using fallback "${fallback}"`)
          effectiveModel = fallback
          provider = fallbackProvider
          modelId = fallbackId
          known = true
        }
        await rpc.setModel(provider, modelId)
      } catch (error: unknown) {
        rpc.close()
        throw error
      }
    }
    const agent = new PiAgent({
      ctx: this.registryCtx,
      session,
      agentOptions: {
        ...agentOptions,
        // Only fill route fields the caller did not provide.
        ...(provider !== '' && requested?.provider === undefined ? { provider } : {}),
        ...(modelId !== '' && requested?.model === undefined ? { model: modelId } : {}),
      },
      rpc,
      cwd,
    })

    // Creation-window composition (the AgentFactory contract): await the
    // caller's setup on the agent's scoped context, invoke its synchronous
    // commit if any, and only then insert/announce — so no observer can see a
    // partially configured child world. Setup composes, it never drives.
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    let stored = storedCount
    const dispose = (): Promise<void> => (disposing ??= (async () => {
      try {
        agent.dispose()
        rpc.close()
      } finally {
        try {
          detachAgent?.()
          detachSession?.()
        } finally {
          await handle?.close().catch(() => undefined)
        }
      }
    })())
    const unfollowOwner = ownerCtx.effect(() => () => {
      if (disposing !== undefined) return
      void dispose()
    })

    try {
      if (setup !== undefined) {
        try {
          const setupCommit = await setup(agent.ctx, agent)
          setupCommit?.commit()
        } catch (error: unknown) {
          this.options.trace?.(`setup FAILED id=${String(id)}: ${String(error)}`)
          throw error
        }
      }
      // Pre-publication appends (constructor seed markers, setup-window
      // events) never re-emit on `session/event`, so store them before live
      // events start routing into the handle.
      if (handle !== undefined) {
        const suffix = session.snapshotEvents(SessionLogOffset(stored))
        if (suffix.length > 0) await handle.append(suffix)
        stored = session.snapshotEvents().length
      }
      detachSession = agent.ctx.sessions.enter(session)
      detachAgent = this.registryCtx.agents.enter(agent, parentAgent)
      agent.ctx.sessions.announce(session)
      await this.registryCtx.agents.announce(agent, source, signal)
      return { agent, dispose: () => dispose().then(() => undefined) }
    } catch (error: unknown) {
      unfollowOwner?.()
      await dispose()
      throw error
    }
  }
}
