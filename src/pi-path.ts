/**
 * Resolve the pi executable.
 *
 * GUI hosts (the desktop app in particular) launch with a minimal PATH that
 * usually omits Homebrew and user-local bin directories, so a bare `pi` name
 * works from a terminal but fails with `spawn pi ENOENT` inside the app.
 * An explicitly configured path always wins; the default name is resolved
 * against the common install locations first and falls back to PATH.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CANDIDATES = [
  '/opt/homebrew/bin/pi',
  '/usr/local/bin/pi',
  join(homedir(), '.local', 'bin', 'pi'),
  join(homedir(), '.npm-global', 'bin', 'pi'),
  join(homedir(), '.bun', 'bin', 'pi'),
]

export function resolvePiPath(configured: string | undefined): string {
  const value = configured === undefined || configured === '' ? 'pi' : configured
  if (value !== 'pi') return value
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return value
}
