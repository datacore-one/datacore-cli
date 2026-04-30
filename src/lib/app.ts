/**
 * Datacore desktop app helpers.
 *
 * Bridges CLI subcommands → daemon HTTP routes (read pidfile/portfile/tokenfile),
 * and the build/install lifecycle. The desktop app's daemon (datacored) writes
 * its port + token to ~/.datacore/app/ on startup; we read those to make
 * authenticated calls without the user needing to know either value.
 *
 * App repo path is auto-detected; override with DATACORE_APP_REPO env var.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const APP_STATE_DIR = join(homedir(), '.datacore', 'app')
const PORT_FILE = join(APP_STATE_DIR, 'datacored.port')
const TOKEN_FILE = join(APP_STATE_DIR, 'datacored.token')
const PID_FILE = join(APP_STATE_DIR, 'datacored.pid')
const LOG_FILE = join(APP_STATE_DIR, 'datacored.log')

const DEFAULT_REPO_CANDIDATES = [
  join(homedir(), 'Data', '2-datacore', '2-projects', 'datacore-app'),
  join(homedir(), 'Data', '2-projects', 'datacore-app'),
  join(homedir(), 'datacore-app'),
]

export class AppError extends Error {
  constructor(public code: string, message: string, public hint?: string) {
    super(message)
  }
}

function readDaemonState(): { port: number; token: string } {
  if (!existsSync(PORT_FILE) || !existsSync(TOKEN_FILE)) {
    throw new AppError(
      'ERR_DAEMON_NOT_RUNNING',
      'Datacore daemon is not running.',
      'Launch the app first: datacore app start',
    )
  }
  const port = Number(readFileSync(PORT_FILE, 'utf8').trim())
  const token = readFileSync(TOKEN_FILE, 'utf8').trim()
  if (!port || !token) {
    throw new AppError(
      'ERR_DAEMON_STATE_INVALID',
      'Daemon state files are present but unreadable.',
    )
  }
  return { port, token }
}

async function daemonFetch(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const { port, token } = readDaemonState()
  const url = `http://127.0.0.1:${port}${path}`
  const init: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Datacore-Actor': 'user.cli',
    },
    signal: AbortSignal.timeout(10_000),
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await fetch(url, init)
  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch {
    parsed = null
  }
  return { status: res.status, body: parsed }
}

export function findAppRepo(): string | null {
  const override = process.env.DATACORE_APP_REPO
  if (override && existsSync(override)) return override
  for (const c of DEFAULT_REPO_CANDIDATES) {
    if (existsSync(c)) return c
  }
  return null
}

const APP_PATH_CANDIDATES_DARWIN = [
  '/Applications/Datacore.app',
  join(homedir(), 'Applications', 'Datacore.app'),
]
const APP_PATH_CANDIDATES_LINUX = [
  '/usr/local/bin/datacore-app',
  '/opt/Datacore/datacore-app',
]

/** True iff the Datacore desktop app is installed OR the daemon is running
 * OR the source repo is present. Used to gate the `app` subcommands so
 * fresh CLI users (without the app yet) get a clear "Coming soon" message
 * instead of confusing errors about missing binaries. */
export function isAppAvailable(): boolean {
  if (process.env.DATACORE_APP_ENABLED === '1') return true
  if (existsSync(PORT_FILE)) return true  // daemon running ⇒ app definitely present
  if (findAppRepo() !== null) return true  // dev with source ⇒ unblock rebuild
  const p = platform()
  if (p === 'darwin') {
    return APP_PATH_CANDIDATES_DARWIN.some(existsSync)
  }
  if (p === 'linux') {
    return APP_PATH_CANDIDATES_LINUX.some(existsSync)
  }
  return false
}

export const COMING_SOON_MESSAGE = `The Datacore desktop app is coming soon.

For now, run ~/Data via the CLI + Claude Code:
  cd ~/Data && claude

The app will ship publicly once it leaves private beta. To track:
  https://datacore.one`

export interface AppStatus {
  running: boolean
  port: number | null
  pid: number | null
  health: 'ok' | 'unreachable' | 'unknown'
}

export async function status(): Promise<AppStatus> {
  let port: number | null = null
  let pid: number | null = null
  if (existsSync(PORT_FILE)) {
    port = Number(readFileSync(PORT_FILE, 'utf8').trim()) || null
  }
  if (existsSync(PID_FILE)) {
    pid = Number(readFileSync(PID_FILE, 'utf8').trim()) || null
  }
  if (!port) return { running: false, port: null, pid, health: 'unknown' }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2_000),
    })
    return {
      running: res.ok,
      port,
      pid,
      health: res.ok ? 'ok' : 'unreachable',
    }
  } catch {
    return { running: false, port, pid, health: 'unreachable' }
  }
}

export function start(): { command: string; ok: boolean; message: string } {
  const p = platform()
  if (p === 'darwin') {
    const r = spawnSync('open', ['-a', 'Datacore'], { stdio: 'pipe' })
    if (r.status === 0) {
      return {
        command: 'open -a Datacore',
        ok: true,
        message: 'Launched /Applications/Datacore.app.',
      }
    }
    return {
      command: 'open -a Datacore',
      ok: false,
      message:
        'Could not launch Datacore.app. Build it first: datacore app rebuild',
    }
  }
  if (p === 'linux') {
    const candidates = ['/usr/local/bin/datacore-app', '/opt/Datacore/datacore-app']
    for (const exe of candidates) {
      if (existsSync(exe)) {
        spawn(exe, [], { detached: true, stdio: 'ignore' }).unref()
        return { command: exe, ok: true, message: `Launched ${exe}.` }
      }
    }
    return {
      command: '',
      ok: false,
      message:
        'Datacore binary not found. Install or build it: datacore app rebuild',
    }
  }
  if (p === 'win32') {
    return {
      command: 'start "" Datacore',
      ok: false,
      message: 'Windows app launch is not yet implemented.',
    }
  }
  return { command: '', ok: false, message: `Unsupported platform: ${p}` }
}

export async function stop(): Promise<{ stopped: boolean; message: string }> {
  // Graceful: ask the daemon to shut down. Falls back to SIGTERM if no admin route.
  try {
    const r = await daemonFetch('POST', '/admin/shutdown')
    if (r.status === 200 || r.status === 202) {
      return { stopped: true, message: 'Daemon shutdown requested.' }
    }
  } catch {
    // fall through
  }
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM')
        return { stopped: true, message: `Sent SIGTERM to pid ${pid}.` }
      } catch {
        // pid stale
      }
    }
  }
  return { stopped: false, message: 'Daemon not running (or pid stale).' }
}

export function rebuild(repo: string): { ok: boolean; message: string } {
  if (!existsSync(join(repo, 'scripts', 'build.sh'))) {
    return { ok: false, message: `scripts/build.sh not found in ${repo}` }
  }
  const r = spawnSync('bash', ['scripts/build.sh'], {
    cwd: repo,
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    return { ok: false, message: 'Build failed (see output above).' }
  }
  // Reinstall to /Applications/Datacore.app on macOS only.
  if (platform() === 'darwin') {
    const built = join(repo, 'shell', 'build', 'bin', 'datacore-app.app')
    const installed = '/Applications/Datacore.app'
    if (!existsSync(built)) {
      return { ok: false, message: `Built artifact missing at ${built}` }
    }
    spawnSync('rm', ['-rf', installed], { stdio: 'inherit' })
    const cp = spawnSync('cp', ['-R', built, installed], { stdio: 'inherit' })
    if (cp.status !== 0) {
      return { ok: false, message: `Failed to copy to ${installed}` }
    }
    return { ok: true, message: `✓ Rebuilt and installed to ${installed}` }
  }
  return { ok: true, message: '✓ Built (manual install required on this OS)' }
}

export function logsPath(): string {
  return LOG_FILE
}

export async function undoLast(): Promise<{ status: number; body: unknown }> {
  return daemonFetch('POST', '/safety/undo-last')
}

export async function listCheckpoints(
  limit = 20,
): Promise<{ status: number; body: unknown }> {
  return daemonFetch('GET', `/safety/checkpoints?limit=${limit}`)
}

export async function undoTo(
  sha: string,
): Promise<{ status: number; body: unknown }> {
  if (!sha || sha.length < 7) {
    throw new AppError('ERR_INVALID_ARGUMENT', 'sha is required (≥ 7 chars)')
  }
  return daemonFetch('POST', '/safety/undo-to', { sha })
}
