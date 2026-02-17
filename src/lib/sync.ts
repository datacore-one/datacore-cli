/**
 * Git sync utilities.
 *
 * Handles git pull/push across all spaces.
 */

import { execSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { join, basename } from 'path'
import { listSpaces } from './space'

const DATA_DIR = join(process.env.HOME || '~', 'Data')

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
 * Pull all git repos.
 */
export function pullAll(options: { stream?: boolean } = {}): SyncResult[] {
  const results: SyncResult[] = []
  const repos = getGitRepos()

  for (const repo of repos) {
    if (options.stream) {
      process.stdout.write(`Pulling ${repo.name}... `)
    }

    const result = runGit(repo.path, ['pull', '--rebase'])

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
  if (isGitRepo(DATA_DIR)) {
    repos.push({ path: DATA_DIR, name: 'Data' })
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
