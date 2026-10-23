/**
 * Git sync utilities.
 *
 * Handles git pull/push across all spaces.
 */

import { execSync } from 'child_process'
import { execFileSync, spawn } from './exec'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, basename, resolve } from 'path'
import { parseDocument } from 'yaml'
import { listSpaces } from './space'
import { dataDir, datacoreLib } from './paths'
import { findPython } from './python'

// Resolved per call, like upgrade.ts: freezing it at import made the tests
// read whichever installation the first importer happened to see.
const DATA_DIR = () => dataDir()

/**
 * Locate the ledger transport, or null on an installation that predates it.
 * Null must stay distinguishable from "the transport failed" — conflating the
 * two is what would quietly restore rebase on machines that have not upgraded.
 */
function findLedgerTransport(): { python: string; script: string } | null {
  const script = join(datacoreLib(), 'ledger_transport.py')
  if (!existsSync(script)) return null
  const python = findPython(DATA_DIR())
  if (!python) return null
  return { python, script }
}

/**
 * Converge one repo: commit local work, merge origin, publish.
 *
 * The transport reports structured JSON — {ok, reason, context} — and its
 * `reason` names the failure an operator has to act on ("auth denied (key
 * rejected — check the key, or a VPN/exit node)") rather than leaving raw git
 * stderr to be guessed at. Surface it verbatim; that naming is the whole point
 * of routing through it.
 */
/**
 * The transport's arguments. `--root` is passed explicitly: the transport
 * decides "this is the root repo" (registry key `<root>`) by comparing paths,
 * and left to its own default it guesses `~/Data`, which is wrong for any
 * installation pointed elsewhere with DATACORE_ROOT.
 */
export function transportArgs(script: string, repoPath: string, root: string): string[] {
  return [script, 'converge', '--space', repoPath, '--root', root]
}

/**
 * Make sure the transport's registry names the root repo.
 *
 * `repositories.yaml` is private and gitignored, and a snapshot does not carry
 * it, so a second machine has none -- and the transport then refuses the root
 * repo with "repository not in registry/repositories.yaml", although nothing
 * is wrong. Spaces declare themselves by marker; the root has no marker, so
 * it needs this one entry. Never rewrites an entry that is there, and never
 * touches a file it cannot parse.
 */
export function ensureRootRegistered(root: string): 'created' | 'added' | 'present' | 'skipped' {
  if (!existsSync(join(root, '.git'))) return 'skipped'
  const dir = join(root, '.datacore', 'registry')
  const file = join(dir, 'repositories.yaml')
  const entry = { category: 'code', host: 'github', transport: 'git', repo: 'datacore' }
  try {
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, [
        '# Repository registry for the sync transport (private, gitignored).',
        '# Created by `datacore update` because this machine had none. It names',
        '# only the Datacore repo itself; spaces register by their own marker.',
        '# Copy the full file from your other machine to add code repos.',
        'repositories:',
        '  <root>:',
        ...Object.entries(entry).map(([k, v]) => `    ${k}: ${v}`),
        '',
      ].join('\n'))
      return 'created'
    }
    const doc = parseDocument(readFileSync(file, 'utf-8'))
    if (doc.errors.length) return 'skipped'
    const repos = doc.get('repositories') as { has?: (k: string) => boolean } | undefined
    if (repos && typeof repos.has === 'function' && repos.has('<root>')) return 'present'
    if (repos !== undefined && (typeof repos !== 'object' || repos === null || typeof repos.has !== 'function')) return 'skipped'
    doc.setIn(['repositories', '<root>'], doc.createNode(entry))
    writeFileSync(file, doc.toString())
    return 'added'
  } catch {
    return 'skipped'
  }
}

/** One plain sentence for the update output, or null when there is nothing to say. */
export function registryNotice(r: ReturnType<typeof ensureRootRegistered>): string | null {
  if (r === 'created') {
    return 'This machine had no .datacore/registry/repositories.yaml (it is private, so git does not carry it). ' +
      'Created one that names only the Datacore repo. To bring over the full registry, copy it from your other machine, ' +
      'or there run `datacore snapshot create --settings --with-registry` and restore that snapshot here.'
  }
  if (r === 'added') return 'Added the Datacore repo itself (<root>) to .datacore/registry/repositories.yaml.'
  return null
}

function convergeRepo(
  t: { python: string; script: string },
  repoPath: string,
): { success: boolean; output: string; error?: string } {
  try {
    const out = execFileSync(
      t.python,
      transportArgs(t.script, repoPath, resolve(DATA_DIR())),
      { encoding: 'utf-8', timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const parsed = JSON.parse(out) as { ok: boolean; reason?: string }
    return parsed.ok
      ? { success: true, output: parsed.reason || 'converged' }
      : { success: false, output: '', error: parsed.reason || 'converge failed' }
  } catch (err: unknown) {
    // A non-zero exit still carries the JSON verdict on stdout, because the
    // transport reports refusals (a real conflict, a denied push) as data
    // rather than as a crash. Losing that to a generic catch would throw away
    // the reason and leave the operator with "pull failed".
    const e = err as { stdout?: string; stderr?: string; message?: string }
    if (e.stdout) {
      try {
        const parsed = JSON.parse(e.stdout) as { ok: boolean; reason?: string }
        return { success: false, output: '', error: parsed.reason || 'converge failed' }
      } catch {
        /* not JSON — fall through to the raw error below */
      }
    }
    return {
      success: false,
      output: '',
      error: e.stderr?.trim() || e.message || 'converge failed',
    }
  }
}

export interface SyncResult {
  path: string
  name: string
  action: 'pull' | 'push' | 'status'
  success: boolean
  output: string
  error?: string
}

export interface SyncStatus {
  path: string
  name: string
  branch: string
  ahead: number
  behind: number
  dirty: boolean
  untracked: number
}

/**
 * Run git command in a directory.
 */
function runGit(cwd: string, args: string[]): { success: boolean; output: string; error?: string } {
  try {
    const output = execSync(`git ${args.join(' ')}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { success: true, output: output.trim() }
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string }
    return {
      success: false,
      output: '',
      error: error.stderr?.trim() || error.message || 'Unknown error',
    }
  }
}

/**
 * Check if a directory is a git repo.
 */
function isGitRepo(path: string): boolean {
  return existsSync(join(path, '.git'))
}

/**
 * Get git status for a repo.
 */
export function getRepoStatus(path: string): SyncStatus | null {
  if (!isGitRepo(path)) return null

  const name = basename(path)

  // Get current branch
  const branchResult = runGit(path, ['branch', '--show-current'])
  const branch = branchResult.success ? branchResult.output : 'unknown'

  // Get ahead/behind
  let ahead = 0
  let behind = 0
  const revResult = runGit(path, ['rev-list', '--left-right', '--count', `HEAD...@{upstream}`])
  if (revResult.success) {
    const [a, b] = revResult.output.split('\t').map(Number)
    ahead = a ?? 0
    behind = b ?? 0
  }

  // Get dirty status
  const statusResult = runGit(path, ['status', '--porcelain'])
  const lines = statusResult.output.split('\n').filter(Boolean)
  const dirty = lines.some((l) => !l.startsWith('??'))
  const untracked = lines.filter((l) => l.startsWith('??')).length

  return {
    path,
    name,
    branch,
    ahead,
    behind,
    dirty,
    untracked,
  }
}

/**
 * Receive others' facts into every repo.
 *
 * This was `git pull --rebase`, and it sat on the update path
 * (`datacore update` -> updateRepos -> pullAll), which made it the single most
 * dangerous line in the CLI: the command an agent runs to REPAIR itself was
 * rewriting its own unpushed commits. Rebase gives every local commit a new
 * hash; if the push afterwards fails — offline, rejected, gated — that work
 * exists under an identity no other machine has seen, and the next watchdog
 * pass treats it as junk. That is how 23 commits in 2-datacore and 27 in 3-fds
 * were stranded on 2026-08-12, including session wrap-ups eleven minutes old.
 *
 * ledger_transport.py is the one writer (DIP-0046): it commits first so work is
 * findable and pushable rather than stashed, merges instead of rebasing, and
 * refuses a genuine content conflict rather than resetting past it.
 *
 * When the transport is absent — a pre-v2 installation, which is exactly the
 * population that most needs `datacore update` to work — fall back to a plain
 * MERGE pull, never to the rebase this replaces. A merge keeps local hashes
 * stable, and with a dirty tree it refuses outright instead of stashing, which
 * is the safe failure. Silently restoring the removed behaviour would defeat
 * the fix on every machine that has not upgraded yet.
 */
export function pullAll(options: { stream?: boolean; onRegistry?: (notice: string) => void } = {}): SyncResult[] {
  const results: SyncResult[] = []
  const repos = getGitRepos()
  const transport = findLedgerTransport()
  if (transport) {
    const notice = registryNotice(ensureRootRegistered(DATA_DIR()))
    if (notice) options.onRegistry?.(notice)
  }

  for (const repo of repos) {
    if (options.stream) {
      process.stdout.write(`Pulling ${repo.name}... `)
    }

    const result = transport
      ? convergeRepo(transport, repo.path)
      : runGit(repo.path, ['pull', '--no-rebase'])

    results.push({
      path: repo.path,
      name: repo.name,
      action: 'pull',
      success: result.success,
      output: result.output,
      error: result.error,
    })

    if (options.stream) {
      console.log(result.success ? '✓' : `✗ ${result.error}`)
    }
  }

  return results
}

/**
 * Push all git repos with changes.
 */
export function pushAll(options: { stream?: boolean; message?: string } = {}): SyncResult[] {
  const results: SyncResult[] = []
  const repos = getGitRepos()
  const commitMessage = options.message || `Sync: ${new Date().toISOString().split('T')[0]}`

  for (const repo of repos) {
    const status = getRepoStatus(repo.path)
    if (!status) continue

    // Skip if nothing to commit or push
    if (!status.dirty && status.ahead === 0) {
      continue
    }

    if (options.stream) {
      process.stdout.write(`Pushing ${repo.name}... `)
    }

    // Stage and commit if dirty
    if (status.dirty) {
      runGit(repo.path, ['add', '-A'])
      runGit(repo.path, ['-c', 'user.name="Datacore CLI"', '-c', 'user.email="cli@datacore.dev"', 'commit', '-m', `"${commitMessage}"`])
    }

    // Push
    const result = runGit(repo.path, ['push'])

    results.push({
      path: repo.path,
      name: repo.name,
      action: 'push',
      success: result.success,
      output: result.output,
      error: result.error,
    })

    if (options.stream) {
      console.log(result.success ? '✓' : `✗ ${result.error}`)
    }
  }

  return results
}

/**
 * Get status of all git repos.
 */
export function statusAll(): SyncStatus[] {
  const repos = getGitRepos()
  const statuses: SyncStatus[] = []

  for (const repo of repos) {
    const status = getRepoStatus(repo.path)
    if (status) {
      statuses.push(status)
    }
  }

  return statuses
}

/**
 * Get all git repos (Data root + spaces).
 */
function getGitRepos(): Array<{ path: string; name: string }> {
  const repos: Array<{ path: string; name: string }> = []

  // Data root
  if (isGitRepo(DATA_DIR())) {
    repos.push({ path: DATA_DIR(), name: 'Data' })
  }

  // All spaces with git
  const spaces = listSpaces()
  for (const space of spaces) {
    if (space.hasGit) {
      repos.push({ path: space.path, name: space.name })
    }
  }

  return repos
}
