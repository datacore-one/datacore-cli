/**
 * Keeping an installation current: the CLI itself, the MCP servers, and the
 * system repo when it is a fork.
 *
 * Three gaps closed here, all found 2026-09-26:
 *   - checkForUpdate() existed and nothing called it, so nobody was told a
 *     new CLI existed;
 *   - update installed datacore-mcp when missing and never upgraded it, and
 *     never touched plur-mcp;
 *   - update pulled `origin`, which for a forked install is the user's own
 *     fork. GitHub does not sync forks, so every forked install stayed at the
 *     version it was installed with while update said "up to date".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFileSync, homeDir, runShell } from './exec'

// ─── Versions ────────────────────────────────────────────────────────────────

function parts(v: string): number[] {
  return (v.match(/\d+/g) ?? []).slice(0, 3).map(Number)
}

export function isNewer(latest: string, current: string): boolean {
  const a = parts(latest), b = parts(current)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

export async function latestVersion(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    return ((await res.json()) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

// ─── The once-a-day notice ───────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000

export function shouldCheckForUpdates(lastCheckedIso: string | undefined, now: number): boolean {
  const last = lastCheckedIso ? Date.parse(lastCheckedIso) : NaN
  return Number.isNaN(last) || now - last >= DAY_MS
}

export function updateNotice(current: string, latest: string): string {
  return `Datacore ${latest} is available (you have ${current}) — run: datacore update`
}

function checkStatePath(): string {
  return join(homeDir(), '.datacore', 'update-check.json')
}

/**
 * Print one line when a newer CLI exists. Human terminals only, at most one
 * registry request a day, never throws, never delays a command by more than
 * the 3 s fetch timeout (and only on the day it checks).
 */
export async function maybeNotifyUpdate(current: string): Promise<void> {
  if (!process.stdout.isTTY || process.env.CI || process.env.DATACORE_NO_UPDATE_CHECK) return
  try {
    const path = checkStatePath()
    let state: { checkedAt?: string; latest?: string } = {}
    try { state = JSON.parse(readFileSync(path, 'utf-8')) } catch { /* first run */ }
    if (shouldCheckForUpdates(state.checkedAt, Date.now())) {
      const latest = await latestVersion('@datacore-one/cli')
      state = { checkedAt: new Date().toISOString(), latest: latest ?? state.latest }
      mkdirSync(join(homeDir(), '.datacore'), { recursive: true })
      writeFileSync(path, JSON.stringify(state) + '\n')
    }
    if (state.latest && isNewer(state.latest, current)) {
      process.stderr.write(`\n  \x1b[33m↑\x1b[0m ${updateNotice(current, state.latest)}\n`)
    }
  } catch { /* a notice must never break a command */ }
}

// ─── Self-update ─────────────────────────────────────────────────────────────

/**
 * Install the latest CLI and re-run `datacore update` under it, so the rest of
 * the update is done by the new code. DATACORE_SELF_UPDATED stops a loop if the
 * registry and the installed version ever disagree.
 *
 * Returns the child's exit code when it re-ran, or null to carry on here.
 */
export async function selfUpdate(current: string, argv: string[], isTTY: boolean): Promise<number | null> {
  if (process.env.DATACORE_SELF_UPDATED) return null
  const latest = await latestVersion('@datacore-one/cli')
  if (!latest || !isNewer(latest, current)) return null
  if (isTTY) console.log(`  Updating the Datacore CLI ${current} → ${latest}...`)
  try {
    runShell('npm install -g @datacore-one/cli@latest', { stdio: isTTY ? 'inherit' : 'pipe', timeout: 300000 })
  } catch {
    if (isTTY) console.log('  Could not update the CLI (continuing with this version): npm install -g @datacore-one/cli@latest')
    return null
  }
  try {
    execFileSync('datacore', argv, { stdio: 'inherit', env: { ...process.env, DATACORE_SELF_UPDATED: '1' } })
    return 0
  } catch (e) {
    return (e as { status?: number }).status ?? 1
  }
}

/** npm packages behind the MCP servers, upgraded when the registry is ahead. */
export const MCP_PACKAGES: Array<{ pkg: string; bin: string }> = [
  { pkg: '@datacore-one/mcp', bin: 'datacore-mcp' },
  { pkg: '@plur-ai/mcp', bin: 'plur-mcp' },
]

export async function upgradeMcpPackages(installedVersion: (bin: string) => string | undefined, isTTY: boolean):
  Promise<{ upgraded: string[]; failed: string[] }> {
  const upgraded: string[] = [], failed: string[] = []
  for (const { pkg, bin } of MCP_PACKAGES) {
    const have = installedVersion(bin)
    if (!have) continue // not installed: install is a separate step
    const latest = await latestVersion(pkg)
    if (!latest || !isNewer(latest, have)) continue
    try {
      runShell(`npm install -g ${pkg}@latest`, { stdio: isTTY ? 'inherit' : 'pipe', timeout: 300000 })
      upgraded.push(`${bin} ${have} → ${latest}`)
    } catch {
      failed.push(`${bin}: npm install -g ${pkg}@latest`)
    }
  }
  return { upgraded, failed }
}

// ─── Fork ← upstream ─────────────────────────────────────────────────────────

export interface MergeUpstreamResult {
  status: 'no-upstream' | 'up-to-date' | 'merged' | 'dirty' | 'conflict' | 'failed'
  files?: string[]
  pushed?: boolean
  detail?: string
}

function git(repo: string, args: string[], timeout = 120000): { ok: boolean; out: string; err: string } {
  try {
    const out = execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe', timeout })
    return { ok: true, out: String(out).trim(), err: '' }
  } catch (e) {
    const x = e as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string }
    return { ok: false, out: String(x.stdout ?? '').trim(), err: String(x.stderr ?? x.message ?? '').trim() }
  }
}

/**
 * Merge upstream's default branch into a fork clone, then push to the fork.
 *
 * Merge, never rebase or reset: the user's own commits stay where they are.
 * Refuses on uncommitted changes to tracked files; aborts a conflicting merge
 * so the repo is exactly as it was, and names the files. The push goes
 * through the pre-push hook, which scans pushes to forks of protected repos.
 */
export function mergeUpstream(repo: string): MergeUpstreamResult {
  if (!existsSync(join(repo, '.git'))) return { status: 'failed', detail: 'not a git repository' }
  if (!git(repo, ['remote', 'get-url', 'upstream']).ok) return { status: 'no-upstream' }

  const fetched = git(repo, ['fetch', '--quiet', 'upstream'], 300000)
  if (!fetched.ok) return { status: 'failed', detail: `fetch upstream: ${fetched.err.split('\n')[0]}` }

  const branch = ['main', 'master'].find((b) => git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/upstream/${b}`]).ok)
  if (!branch) return { status: 'failed', detail: 'upstream has no main or master branch' }
  const ref = `upstream/${branch}`

  if (git(repo, ['merge-base', '--is-ancestor', ref, 'HEAD']).ok) return { status: 'up-to-date' }

  if (!git(repo, ['diff', '--quiet']).ok || !git(repo, ['diff', '--cached', '--quiet']).ok) {
    return { status: 'dirty', detail: 'commit or stash your changes to tracked files, then run datacore update again' }
  }

  const merged = git(repo, ['merge', '--no-edit', ref])
  if (!merged.ok) {
    const files = git(repo, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean)
    git(repo, ['merge', '--abort'])
    return files.length
      ? { status: 'conflict', files }
      : { status: 'failed', detail: merged.err.split('\n')[0] }
  }

  const pushed = git(repo, ['push', '--quiet', 'origin', 'HEAD'], 300000)
  return { status: 'merged', pushed: pushed.ok, detail: pushed.ok ? undefined : `push to your fork failed: ${pushed.err.split('\n').pop()}` }
}
