/**
 * Forward the user's DSH provider keys to the pi child.
 *
 * DSH stores provider credentials in `$DSH_HOME/.credentials.yaml` under a
 * flat `refs:` block (NEWAPI_API_KEY, DEEPSEEK_API_KEY, …). A GUI-launched app
 * does not put them in the process environment, so pi's built-in providers
 * (DeepSeek, …) never appear in its catalog. Passing the `*_API_KEY` refs
 * through gives pi the same providers DSH is configured with, without copying
 * keys into pi's own config file.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Parse the flat `refs:` block into exported environment variables. */
export function dshCredentialEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
    let inRefs = false
    for (const raw of text.split(/\r?\n/)) {
      if (/^refs:\s*$/.test(raw)) {
        inRefs = true
        continue
      }
      if (!inRefs) continue
      // A new top-level key ends the refs block.
      if (/^\S/.test(raw)) break
      const match = raw.match(/^\s+([A-Z][A-Z0-9_]*):\s*(.*)$/)
      if (match === null) continue
      const [, name, rawValue] = match
      if (!/_API_KEY$/.test(name)) continue
      let value = rawValue.trim()
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1)
      }
      if (value !== '') env[name] = value
    }
  } catch {
    // No DSH home or no credential store: pi keeps using its own config.
  }
  return env
}
