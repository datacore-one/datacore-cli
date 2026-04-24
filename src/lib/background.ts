/**
 * Background process spawning for detached jobs that survive parent exit.
 * Used by init (ingest) and potentially nightshift.
 */

import { spawn } from 'child_process'
import { openSync, closeSync, mkdirSync } from 'fs'
import { join } from 'path'
import { DATA_DIR, DATACORE_DIR } from '../paths'

const STATE_DIR = join(DATACORE_DIR, 'state')

export interface BackgroundJob {
  pid: number
  logFile: string
  label: string
  startedAt: string
}

/**
 * Spawn a detached background process that survives parent exit.
 * Each job gets its own log file in .datacore/state/.
 */
export function spawnBackground(
  command: string,
  args: string[],
  label: string
): BackgroundJob | null {
  mkdirSync(STATE_DIR, { recursive: true })

  const timestamp = Date.now()
  const logFile = join(STATE_DIR, `bg-${label}-${timestamp}.log`)

  let outFd: number | undefined
  try {
    outFd = openSync(logFile, 'a')

    const child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', outFd, outFd],
      cwd: DATA_DIR,
      env: { ...process.env },
    })
    child.unref()

    // Parent releases fd; child retains its inherited copy
    try { closeSync(outFd) } catch { /* ignore close errors */ }

    return {
      pid: child.pid ?? -1,
      logFile,
      label,
      startedAt: new Date().toISOString(),
    }
  } catch {
    if (outFd !== undefined) {
      try { closeSync(outFd) } catch { /* ignore */ }
    }
    return null
  }
}
