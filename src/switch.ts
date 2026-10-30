/**
 * `/pi` and `/dsh` — switch the process-wide agent loop from the composer.
 *
 * DSH 0.2 registers exactly one AgentFactory per process, so the engine is a
 * global choice rather than a per-session one. This plugin stays mounted
 * independently of the `dsh-pi-agent` bundle (a profile patch row, not part of
 * the bundle layer), so `/pi` keeps working after the bundle has been turned
 * off and `/dsh` keeps working while it is on.
 *
 * The actual flip goes through the host plugin manager, the same route the
 * Plugins page uses: it persists the bundle selection and reports whether the
 * change applied live or needs a restart.
 */

import { appendFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

/** Diagnostics sink shared with the loop plugin. */
function trace(line: string): void {
  try { appendFileSync('/tmp/dsh-pi-agent.log', `${new Date().toISOString()} [switch] ${line}\n`) } catch { /* diagnostics must never break the command */ }
}

interface CommandResultLike {
  kind: 'success' | 'error'
  text?: string
}

interface CommandDefinitionLike {
  name: string
  description: string
  handler: (invocation: { rawInput: string }) => CommandResultLike | Promise<CommandResultLike>
}

interface CommandRuntimeLike {
  register(definition: CommandDefinitionLike): () => void
}

interface ChangeResultLike {
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  error?: { message?: string }
}

interface BundleInfoLike {
  name: string
  enabled: boolean
}

interface PluginManagerLike {
  listBundles(): Promise<BundleInfoLike[]>
  setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResultLike>
}

interface SwitchContext extends Context {
  commands: CommandRuntimeLike
  pluginManager: PluginManagerLike
}

const BUNDLE = 'dsh-pi-agent'

export const name = 'pi-engine-switch'

export const inject = ['commands', 'pluginManager']

/** Whether the pi bundle currently contributes its layer. */
async function piEnabled(ctx: SwitchContext): Promise<boolean | undefined> {
  const bundles = await ctx.pluginManager.listBundles()
  return bundles.find((bundle) => bundle.name === BUNDLE)?.enabled
}

/**
 * Flip the bundle AFTER the command result has been delivered.
 *
 * The switch disposes the agent loop that is currently carrying this very
 * command. Awaiting it inside the handler loses the command's `done` event
 * with that loop, and the composer stays on "executing" forever. Returning
 * first and flipping on a timer lets the command turn settle, then the
 * activation runs; its outcome is written to the plugin's diagnostics log.
 */
async function switchEngine(ctx: SwitchContext, enabled: boolean): Promise<CommandResultLike> {
  try {
    const current = await piEnabled(ctx)
    if (current === enabled) {
      return { kind: 'success', text: enabled ? '当前已经是 pi agent loop。' : '当前已经是 DSH 原生 agent loop。' }
    }
    setTimeout(() => {
      void ctx.pluginManager.setBundleEnabled(BUNDLE, enabled).then(
        (result) => trace(`switch pi=${String(enabled)} application=${result.application}`),
        (error: unknown) => trace(`switch pi=${String(enabled)} FAILED: ${String(error)}`),
      )
    }, 1200)
    return {
      kind: 'success',
      text: enabled
        ? '正在切换到 pi agent loop…新会话生效；请先在模型选择里选 pi 支持的模型（如 newapi/…），并新建会话。'
        : '正在切回 DSH 原生 agent loop…新会话生效；当前会话请新建或重新打开后继续。',
    }
  } catch (error: unknown) {
    return { kind: 'error', text: `切换失败: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function apply(ctx: SwitchContext): void {
  ctx.commands.register({
    name: 'pi',
    description: '把 agent loop 全局切换为 pi（新会话生效）',
    handler: () => switchEngine(ctx, true),
  })
  ctx.commands.register({
    name: 'dsh',
    description: '全局切回 DSH 原生 agent loop（新会话生效）',
    handler: () => switchEngine(ctx, false),
  })
  ctx.commands.register({
    name: 'engine',
    description: '查看当前 agent loop 引擎（pi / DSH 原生）',
    handler: async () => {
      const enabled = await piEnabled(ctx)
      if (enabled === undefined) return { kind: 'error', text: `未找到 bundle 「${BUNDLE}」。` }
      return { kind: 'success', text: `当前 agent loop: ${enabled ? 'pi' : 'DSH 原生'}。` }
    },
  })
}
