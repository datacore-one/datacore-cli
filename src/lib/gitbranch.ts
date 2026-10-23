/**
 * Keeping clones ON a branch.
 *
 * `snapshot restore` used to `git checkout <commit>`, which leaves a detached
 * HEAD, and every later `git pull` then fails with "You are not currently on a
 * branch". On a real second-machine install that was 27 of 37 modules failing
 * the first `datacore update` after a successful restore.
 *
 * Two operations live here: put a fresh clone on its branch at an exact commit
 * (restore), and move an already-detached clone back onto its default branch
 * (update) -- the second only when no commit would be left behind.
 */
import { execFileSync } from './exec'

function git(cwd: string, args: string[], timeout = 60000): { ok: boolean; out: string; err: string } {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout })
    return { ok: true, out: out.trim(), err: '' }
  } catch (e) {
    const x = e as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string }
    return { ok: false, out: String(x.stdout ?? '').trim(), err: String(x.stderr ?? x.message ?? '').trim() }
  }
}

/** The branch origin's HEAD points at, else main or master if origin has one. */
export function defaultBranch(path: string): string | null {
  const head = git(path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head.ok && head.out.startsWith('origin/')) return head.out.slice('origin/'.length)
  for (const b of ['main', 'master']) {
    if (git(path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]).ok) return b
  }
  return null
}

export function isDetached(path: string): boolean {
  return !git(path, ['symbolic-ref', '-q', 'HEAD']).ok
}

/**
 * Put a FRESH clone on `branch` (or the default branch) at `commit`, tracking
 * origin. Only for a clone made a moment ago: `switch -C` moves the local
 * branch, which on a fresh clone holds nothing that is not also on origin.
 */
export function checkoutOnBranch(path: string, commit: string, branch?: string): { ok: boolean; warning?: string } {
  const b = branch || defaultBranch(path)
  if (!b) {
    const r = git(path, ['checkout', '-q', commit])
    return r.ok
      ? { ok: true, warning: `${path}: origin has no default branch, left at ${commit.slice(0, 7)} (detached)` }
      : { ok: false, warning: r.err }
  }
  const sw = git(path, ['switch', '-q', '-C', b, commit])
  if (!sw.ok) return { ok: false, warning: sw.err }
  if (git(path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]).ok) {
    git(path, ['branch', '-q', `--set-upstream-to=origin/${b}`, b])
  }
  return { ok: true }
}

/**
 * Move a detached clone back onto its default branch so `git pull` works.
 *
 * Never discards work: if HEAD holds commits that are on neither the local nor
 * the remote default branch, nothing is changed and the error says how to keep
 * them. A dirty working tree that would be overwritten makes `git switch`
 * refuse, and that refusal is passed on unchanged.
 */
export function reattach(path: string): { ok: true; switched: boolean; branch?: string } | { ok: false; error: string } {
  if (!isDetached(path)) return { ok: true, switched: false }
  git(path, ['fetch', '-q', 'origin'])
  const b = defaultBranch(path)
  if (!b) return { ok: false, error: `${path} is on a detached HEAD and origin has no default branch to return to` }

  const remote = `refs/remotes/origin/${b}`
  const local = `refs/heads/${b}`
  const hasLocal = git(path, ['rev-parse', '--verify', '--quiet', local]).ok
  const contained = git(path, ['merge-base', '--is-ancestor', 'HEAD', remote]).ok
    || (hasLocal && git(path, ['merge-base', '--is-ancestor', 'HEAD', local]).ok)
  if (!contained) {
    const n = git(path, ['rev-list', '--count', 'HEAD', '--not', remote, ...(hasLocal ? [local] : [])])
    const count = n.ok ? n.out : 'some'
    return {
      ok: false,
      error: `detached HEAD with ${count} commit(s) not on any branch (${b} does not contain them); nothing was changed. ` +
        `Keep them with: git -C ${path} switch -c <new-branch-name>, then merge into ${b}`,
    }
  }

  const sw = hasLocal
    ? git(path, ['switch', '-q', b])
    : git(path, ['switch', '-q', '-c', b, '--track', `origin/${b}`])
  if (!sw.ok) return { ok: false, error: `could not switch from detached HEAD to ${b}: ${sw.err.split('\n')[0]}` }
  return { ok: true, switched: true, branch: b }
}
