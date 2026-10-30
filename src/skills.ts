/**
 * Bridge DSH's installed skills into pi's skill directory.
 *
 * DSH loads user skills from `$DSH_HOME/skills/<name>/SKILL.md` and pi
 * discovers `~/.pi/agent/skills/<name>/SKILL.md`, so the same skill directory
 * works in both engines once it is linked. The sync is additive: an existing
 * pi entry is never replaced, and single-file `.md` skills (DSH's older
 * format) are skipped because pi requires a directory with SKILL.md.
 */

import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SkillSyncResult {
  linked: string[]
  skipped: string[]
}

/** Link every DSH skill directory pi does not already have. */
export function syncDshSkills(logger?: (line: string) => void): SkillSyncResult {
  const result: SkillSyncResult = { linked: [], skipped: [] }
  const destRoot = join(homedir(), '.pi', 'agent', 'skills')
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const sources = [join(dshHome, 'skills'), join(homedir(), '.agents', 'skills')]

  try {
    mkdirSync(destRoot, { recursive: true })
  } catch {
    return result
  }

  for (const source of sources) {
    let entries: string[]
    try {
      entries = readdirSync(source)
    } catch {
      continue
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      const from = join(source, name)
      try {
        if (!statSync(from).isDirectory()) continue
        if (!existsSync(join(from, 'SKILL.md'))) continue
        const to = join(destRoot, name)
        if (existsSync(to)) {
          result.skipped.push(name)
          continue
        }
        symlinkSync(from, to, 'dir')
        result.linked.push(name)
        logger?.(`[skills] linked "${name}" -> ${from}`)
      } catch {
        // Unreadable or conflicting entry: leave pi's directory untouched.
      }
    }
  }
  return result
}
