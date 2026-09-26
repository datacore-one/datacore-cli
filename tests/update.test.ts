/**
 * `datacore update` brings a fork up to date with upstream.
 *
 * init forks datacore-one/datacore, clones the fork, and adds `upstream`. update
 * then pulled `origin` — the user's own fork, which GitHub never syncs — so
 * every forked install stayed at the version it was installed with while
 * update reported "up to date". These tests use real repos: an upstream, a
 * fork, and the user's clone of the fork.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { mergeUpstream, isNewer, shouldCheckForUpdates, updateNotice } from '../src/lib/selfupdate'

let dir: string
// Real repos, real fetch/merge/push: ~2 s idle, far more on a loaded machine.
const GIT_TIMEOUT = 30000
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args],
    { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim()

/** upstream (bare) -> fork (bare, a copy) -> clone (the user's ~/Data). */
function setup(): { upstreamWork: string; fork: string; clone: string } {
  dir = mkdtempSync(join(tmpdir(), 'dc-cli-update-'))
  const upstreamWork = join(dir, 'upstream-work')
  execFileSync('git', ['init', '-q', '-b', 'main', upstreamWork])
  writeFileSync(join(upstreamWork, 'README.md'), 'v1\n')
  git(upstreamWork, 'add', '.'); git(upstreamWork, 'commit', '-q', '-m', 'v1')
  const upstream = join(dir, 'upstream.git')
  git(dir, 'clone', '-q', '--bare', upstreamWork, upstream)
  const fork = join(dir, 'fork.git')
  git(dir, 'clone', '-q', '--bare', upstream, fork)
  const clone = join(dir, 'Data')
  git(dir, 'clone', '-q', fork, clone)
  git(clone, 'remote', 'add', 'upstream', upstream)
  // mergeUpstream runs plain git: give the clone an identity and no hooks, so
  // the result does not depend on the machine's global config.
  git(clone, 'config', 'user.email', 't@example.com')
  git(clone, 'config', 'user.name', 'T')
  git(clone, 'config', 'core.hooksPath', '/dev/null')
  // upstream moves on after the fork was made
  writeFileSync(join(upstreamWork, 'README.md'), 'v2\n')
  git(upstreamWork, 'commit', '-q', '-am', 'v2')
  git(upstreamWork, 'push', '-q', upstream, 'main')
  return { upstreamWork, fork, clone }
}

beforeEach(() => { dir = '' })
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('mergeUpstream', () => {
  it('merges upstream into the fork clone and pushes it to the fork', () => {
    const { fork, clone } = setup()
    const r = mergeUpstream(clone)
    expect(r.status).toBe('merged')
    expect(readFileSync(join(clone, 'README.md'), 'utf-8')).toBe('v2\n')
    expect(r.pushed).toBe(true)
    expect(git(fork, 'log', '-1', '--format=%s', 'main')).toBe('v2')
  }, GIT_TIMEOUT)

  it('keeps the user\'s own commits (merge, never rebase or reset)', () => {
    const { clone } = setup()
    writeFileSync(join(clone, 'mine.md'), 'my change\n')
    git(clone, 'add', '.'); git(clone, 'commit', '-q', '-m', 'mine')
    expect(mergeUpstream(clone).status).toBe('merged')
    expect(existsSync(join(clone, 'mine.md'))).toBe(true)
    expect(readFileSync(join(clone, 'README.md'), 'utf-8')).toBe('v2\n')
  }, GIT_TIMEOUT)

  it('reports up-to-date the second time', () => {
    const { clone } = setup()
    mergeUpstream(clone)
    expect(mergeUpstream(clone).status).toBe('up-to-date')
  }, GIT_TIMEOUT)

  it('refuses when tracked files have uncommitted changes, and changes nothing', () => {
    const { clone } = setup()
    writeFileSync(join(clone, 'README.md'), 'editing\n')
    const head = git(clone, 'rev-parse', 'HEAD')
    const r = mergeUpstream(clone)
    expect(r.status).toBe('dirty')
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(clone, 'README.md'), 'utf-8')).toBe('editing\n')
  }, GIT_TIMEOUT)

  it('aborts a conflicting merge, leaves the repo clean, and names the files', () => {
    const { clone } = setup()
    writeFileSync(join(clone, 'README.md'), 'my v2\n')
    git(clone, 'commit', '-q', '-am', 'mine')
    const head = git(clone, 'rev-parse', 'HEAD')
    const r = mergeUpstream(clone)
    expect(r.status).toBe('conflict')
    expect(r.files).toEqual(['README.md'])
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(clone, 'status', '--porcelain')).toBe('')
  }, GIT_TIMEOUT)

  it('does nothing for an install cloned straight from upstream (no upstream remote)', () => {
    const { clone } = setup()
    git(clone, 'remote', 'remove', 'upstream')
    expect(mergeUpstream(clone).status).toBe('no-upstream')
  }, GIT_TIMEOUT)
})

describe('version check', () => {
  it('compares versions numerically', () => {
    expect(isNewer('2.10.0', '2.9.9')).toBe(true)
    expect(isNewer('2.5.1', '2.5.1')).toBe(false)
    expect(isNewer('2.5.0', '2.5.1')).toBe(false)
  })
  it('checks at most once a day', () => {
    const now = Date.parse('2026-09-26T12:00:00Z')
    expect(shouldCheckForUpdates(undefined, now)).toBe(true)
    expect(shouldCheckForUpdates('2026-09-26T01:00:00Z', now)).toBe(false)
    expect(shouldCheckForUpdates('2026-09-25T11:00:00Z', now)).toBe(true)
    expect(shouldCheckForUpdates('garbage', now)).toBe(true)
  })
  it('names the command to run', () => {
    expect(updateNotice('2.5.1', '2.6.0')).toContain('datacore update')
    expect(updateNotice('2.5.1', '2.6.0')).toContain('2.6.0')
  })
})
