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

import type { Context } from '@deepseek-ai/cordis'

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

/** Flip the bundle and translate the manager's outcome into one line. */
async function switchEngine(ctx: SwitchContext, enabled: boolean): Promise<CommandResultLike> {
  try {
    const current = await piEnabled(ctx)
    if (current === enabled) {
      return { kind: 'success', text: enabled ? '当前已经是 pi agent loop。' : '当前已经是 DSH 原生 agent loop。' }
    }
    const result = await ctx.pluginManager.setBundleEnabled(BUNDLE, enabled)
    switch (result.application) {
      case 'applied':
        return {
          kind: 'success',
          text: enabled
            ? '已切换到 pi agent loop，新会话立即生效。'
            : '已切回 DSH 原生 agent loop，新会话立即生效。',
        }
      case 'restart-required':
        return {
          kind: 'success',
          text: enabled
            ? '已启用 pi agent loop，重启 App 后生效。'
            : '已关闭 pi agent loop，重启 App 后恢复原生 loop。',
        }
      case 'overridden':
        return { kind: 'error', text: '设置已保存，但被更高优先级的补丁层覆盖。' }
      case 'cancelled':
        return { kind: 'error', text: '切换被取消。' }
      case 'failed':
        return { kind: 'error', text: `切换失败: ${result.error?.message ?? 'unknown error'}` }
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
