/**
 * Setting up Datacore on a second machine from a snapshot.
 *
 * Every case here comes from a real headless Ubuntu 24.04 install made from a
 * snapshot of an existing installation (2026-10-23). The result worked, but
 * `datacore update` afterwards reported "37 module(s) failed to update":
 *
 *   - 10 modules that ship inside the root Datacore repo (gtd, research,
 *     outbox, ...) were reported as "Not a git repository" and counted as
 *     failures. They are core: tracked by the root repo, updated with it.
 *   - 27 modules failed `git pull` because `snapshot restore` had checked each
 *     one out at its exact commit, leaving it on a detached HEAD.
 *   - The root repo was reported as "not in registry" because a new machine
 *     has no repositories.yaml (it is gitignored, and the snapshot does not
 *     carry it).
 *
 * These tests use real git repositories, so they test what git does, not what
 * we believe it does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { parse } from 'yaml'

const GIT_TIMEOUT = 60000
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@example.com', '-c', 'user.name=T',
    '-c', 'init.defaultBranch=main', ...args],
    { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim()

let dir = ''
let root = ''

/** A root Datacore repo with one core module (tracked by the root). */
function makeRoot(): string {
  dir = mkdtempSync(join(tmpdir(), 'dc-second-machine-'))
  root = join(dir, 'Data')
  mkdirSync(join(root, '.datacore', 'modules', 'gtd'), { recursive: true })
  writeFileSync(join(root, '.datacore', 'modules', 'gtd', 'module.yaml'), 'name: gtd\nversion: 1.0.0\n')
  // Own-repo modules are gitignored by the root, as in the real repo.
  writeFileSync(join(root, '.gitignore'), '.datacore/modules/news/\n.datacore/modules/scratch/\n[1-9]-*/\n0-personal/\n')
  git(dir, 'init', '-q', '-b', 'main', root)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'root')
  process.env.DATACORE_ROOT = root
  return root
}

/** A bare upstream repo for a module, with two commits. Returns [url, firstCommit, secondCommit]. */
function makeUpstream(name: string, manifest = true): [string, string, string] {
  const work = join(dir, `${name}-work`)
  git(dir, 'init', '-q', '-b', 'main', work)
  if (manifest) writeFileSync(join(work, 'module.yaml'), `name: ${name}\nversion: 0.1.0\n`)
  writeFileSync(join(work, 'README.md'), 'v1\n')
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'v1')
  const first = git(work, 'rev-parse', 'HEAD')
  writeFileSync(join(work, 'README.md'), 'v2\n')
  git(work, 'commit', '-q', '-am', 'v2')
  const second = git(work, 'rev-parse', 'HEAD')
  const bare = join(dir, `${name}.git`)
  git(dir, 'clone', '-q', '--bare', work, bare)
  return [bare, first, second]
}

/** Push one more commit to a bare upstream. */
function advance(name: string): string {
  const work = join(dir, `${name}-work`)
  writeFileSync(join(work, 'README.md'), 'v3\n')
  git(work, 'commit', '-q', '-am', 'v3')
  git(work, 'push', '-q', join(dir, `${name}.git`), 'main')
  return git(work, 'rev-parse', 'HEAD')
}

function cloneModule(url: string, name: string): string {
  const path = join(root, '.datacore', 'modules', name)
  git(dir, 'clone', '-q', url, path)
  git(path, 'config', 'user.email', 't@example.com')
  git(path, 'config', 'user.name', 'T')
  git(path, 'config', 'core.hooksPath', '/dev/null')
  return path
}

beforeEach(() => { dir = ''; root = '' })
afterEach(() => {
  delete process.env.DATACORE_ROOT
  if (dir) rmSync(dir, { recursive: true, force: true })
})

// ─── 1. Core modules ─────────────────────────────────────────────────────────

describe('core modules (shipped inside the root repo)', () => {
  it('are recognised as core, not as "Not a git repository"', async () => {
    makeRoot()
    const { moduleKind } = await import('../src/lib/module')
    expect(moduleKind(join(root, '.datacore', 'modules', 'gtd'))).toBe('core')
  }, GIT_TIMEOUT)

  it('an untracked module with no repo of its own is still local', async () => {
    makeRoot()
    mkdirSync(join(root, '.datacore', 'modules', 'scratch'))
    writeFileSync(join(root, '.datacore', 'modules', 'scratch', 'module.yaml'), 'name: scratch\n')
    const { moduleKind } = await import('../src/lib/module')
    expect(moduleKind(join(root, '.datacore', 'modules', 'scratch'))).toBe('local')
  }, GIT_TIMEOUT)

  it('update reports them as core and does not count them as failed', async () => {
    makeRoot()
    const { updateModules, tallyModuleResults } = await import('../src/lib/module')
    const results = updateModules()
    const gtd = results.find((r) => r.name === 'gtd')!
    expect(gtd.core).toBe(true)
    expect(gtd.error).toBeUndefined()
    const t = tallyModuleResults(results)
    expect(t.failed).toBe(0)
    expect(t.core).toBe(1)
  }, GIT_TIMEOUT)

  it('snapshot create records them as core, and restore neither clones nor fails them', async () => {
    makeRoot()
    const { createSnapshot, restoreFromSnapshot } = await import('../src/lib/snapshot')
    const snap = createSnapshot()
    const gtd = snap.modules.find((m) => m.name === 'gtd')!
    expect(gtd.source).toBe('core')
    expect(gtd.commit).toBeUndefined()

    // A core module missing on the target is not a clone job and not a failure.
    rmSync(join(root, '.datacore', 'modules', 'gtd'), { recursive: true, force: true })
    const r = restoreFromSnapshot(snap, { spaces: false })
    expect(r.modulesFailed).toEqual([])
    expect(r.modulesInstalled).toEqual([])
    expect(r.warnings.join('\n')).not.toContain('was local')
  }, GIT_TIMEOUT)

  it('snapshot diff does not report core modules as changed or removed', async () => {
    makeRoot()
    const { createSnapshot, diffSnapshot } = await import('../src/lib/snapshot')
    const snap = createSnapshot()
    const d = diffSnapshot(snap)
    expect(d.modules.changed).toEqual([])
    expect(d.modules.removed).toEqual([])
  }, GIT_TIMEOUT)

  it('snapshot create records where the root repo comes from', async () => {
    makeRoot()
    git(root, 'remote', 'add', 'origin', 'https://example.com/me/datacore.git')
    const { createSnapshot } = await import('../src/lib/snapshot')
    const snap = createSnapshot()
    expect(snap.root?.source).toBe('https://example.com/me/datacore.git')
    expect(snap.root?.branch).toBe('main')
  }, GIT_TIMEOUT)
})

// ─── 3. Detached modules ─────────────────────────────────────────────────────

describe('snapshot restore leaves modules on their branch', () => {
  it('restores a module at the snapshot commit, on its branch, tracking origin', async () => {
    makeRoot()
    const [url, first] = makeUpstream('news')
    const { restoreFromSnapshot } = await import('../src/lib/snapshot')
    const r = restoreFromSnapshot({
      version: '1.0', created: '', cliVersion: '', platform: '', dependencies: [], spaces: [],
      modules: [{ name: 'news', source: url, commit: first, branch: 'main' }],
    })
    expect(r.modulesFailed).toEqual([])
    const path = join(root, '.datacore', 'modules', 'news')
    expect(git(path, 'rev-parse', 'HEAD')).toBe(first)
    expect(git(path, 'branch', '--show-current')).toBe('main')
    expect(git(path, 'rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/main')
  }, GIT_TIMEOUT)

  it('a module restored with no branch recorded lands on the default branch', async () => {
    makeRoot()
    const [url, first] = makeUpstream('news')
    const { restoreFromSnapshot } = await import('../src/lib/snapshot')
    restoreFromSnapshot({
      version: '1.0', created: '', cliVersion: '', platform: '', dependencies: [], spaces: [],
      modules: [{ name: 'news', source: url, commit: first }],
    })
    const path = join(root, '.datacore', 'modules', 'news')
    expect(git(path, 'branch', '--show-current')).toBe('main')
    expect(git(path, 'rev-parse', 'HEAD')).toBe(first)
  }, GIT_TIMEOUT)

  it('restores a space on its branch too', async () => {
    makeRoot()
    const [url, first] = makeUpstream('1-team', false)
    const { restoreFromSnapshot } = await import('../src/lib/snapshot')
    const r = restoreFromSnapshot({
      version: '1.0', created: '', cliVersion: '', platform: '', dependencies: [], modules: [],
      spaces: [{ name: '1-team', number: 1, type: 'team', source: url, commit: first }],
    })
    expect(r.spacesCreated).toEqual(['1-team'])
    const path = join(root, '1-team')
    expect(git(path, 'branch', '--show-current')).toBe('main')
    expect(git(path, 'rev-parse', 'HEAD')).toBe(first)
  }, GIT_TIMEOUT)

  it('the next update pulls a restored module forward', async () => {
    makeRoot()
    const [url, first] = makeUpstream('news')
    const { restoreFromSnapshot } = await import('../src/lib/snapshot')
    restoreFromSnapshot({
      version: '1.0', created: '', cliVersion: '', platform: '', dependencies: [], spaces: [],
      modules: [{ name: 'news', source: url, commit: first, branch: 'main' }],
    })
    const third = advance('news')
    const { updateModules } = await import('../src/lib/module')
    const res = updateModules().find((r) => r.name === 'news')!
    expect(res.error).toBeUndefined()
    expect(res.updated).toBe(true)
    expect(git(join(root, '.datacore', 'modules', 'news'), 'rev-parse', 'HEAD')).toBe(third)
  }, GIT_TIMEOUT)
})

describe('update repairs a module that is already detached', () => {
  it('switches back to the default branch and pulls', async () => {
    makeRoot()
    const [url, first] = makeUpstream('news')
    const path = cloneModule(url, 'news')
    git(path, 'checkout', '-q', '--detach', first) // what restore used to do
    const third = advance('news')
    const { updateModules } = await import('../src/lib/module')
    const res = updateModules().find((r) => r.name === 'news')!
    expect(res.error).toBeUndefined()
    expect(git(path, 'branch', '--show-current')).toBe('main')
    expect(git(path, 'rev-parse', 'HEAD')).toBe(third)
  }, GIT_TIMEOUT)

  it('refuses, changes nothing, and says how to keep them when local commits would be lost', async () => {
    makeRoot()
    const [url, first] = makeUpstream('news')
    const path = cloneModule(url, 'news')
    git(path, 'checkout', '-q', '--detach', first)
    writeFileSync(join(path, 'mine.md'), 'my work\n')
    git(path, 'add', '.'); git(path, 'commit', '-q', '-m', 'mine')
    const head = git(path, 'rev-parse', 'HEAD')
    const { updateModules } = await import('../src/lib/module')
    const res = updateModules().find((r) => r.name === 'news')!
    expect(res.updated).toBe(false)
    expect(res.error).toContain('not on any branch')
    expect(res.error).toContain('git -C')
    expect(git(path, 'rev-parse', 'HEAD')).toBe(head)
    expect(existsSync(join(path, 'mine.md'))).toBe(true)
  }, GIT_TIMEOUT)
})

// ─── 2. Root repo registry ───────────────────────────────────────────────────

describe('root repo in the transport registry', () => {
  it('a new machine with no registry gets one that names the root as <root>', async () => {
    makeRoot()
    const { ensureRootRegistered } = await import('../src/lib/sync')
    expect(ensureRootRegistered(root)).toBe('created')
    const reg = parse(readFileSync(join(root, '.datacore', 'registry', 'repositories.yaml'), 'utf-8'))
    expect(reg.repositories['<root>'].category).toBe('code')
  }, GIT_TIMEOUT)

  it('leaves a registry that already lists <root> untouched', async () => {
    makeRoot()
    mkdirSync(join(root, '.datacore', 'registry'), { recursive: true })
    const text = '# mine\nrepositories:\n  <root>:\n    category: code\n    repo: datacore\n'
    writeFileSync(join(root, '.datacore', 'registry', 'repositories.yaml'), text)
    const { ensureRootRegistered } = await import('../src/lib/sync')
    expect(ensureRootRegistered(root)).toBe('present')
    expect(readFileSync(join(root, '.datacore', 'registry', 'repositories.yaml'), 'utf-8')).toBe(text)
  }, GIT_TIMEOUT)

  it('adds <root> to a registry that lacks it, keeping the other entries and comments', async () => {
    makeRoot()
    mkdirSync(join(root, '.datacore', 'registry'), { recursive: true })
    writeFileSync(join(root, '.datacore', 'registry', 'repositories.yaml'),
      '# keep me\nrepositories:\n  1-team:\n    category: knowledge\n')
    const { ensureRootRegistered } = await import('../src/lib/sync')
    expect(ensureRootRegistered(root)).toBe('added')
    const text = readFileSync(join(root, '.datacore', 'registry', 'repositories.yaml'), 'utf-8')
    expect(text).toContain('# keep me')
    const reg = parse(text)
    expect(reg.repositories['1-team'].category).toBe('knowledge')
    expect(reg.repositories['<root>'].category).toBe('code')
  }, GIT_TIMEOUT)

  it('does not touch a registry it cannot parse', async () => {
    makeRoot()
    mkdirSync(join(root, '.datacore', 'registry'), { recursive: true })
    writeFileSync(join(root, '.datacore', 'registry', 'repositories.yaml'), 'repositories: [oops\n')
    const { ensureRootRegistered } = await import('../src/lib/sync')
    expect(ensureRootRegistered(root)).toBe('skipped')
    expect(readFileSync(join(root, '.datacore', 'registry', 'repositories.yaml'), 'utf-8')).toBe('repositories: [oops\n')
  }, GIT_TIMEOUT)

  it('tells the transport which directory is the root', async () => {
    makeRoot()
    const { transportArgs } = await import('../src/lib/sync')
    expect(transportArgs('/x/ledger_transport.py', root, root)).toEqual(
      ['/x/ledger_transport.py', 'converge', '--space', root, '--root', root])
  })
  it('says plainly when this machine had no registry and what to do about it', async () => {
    const { registryNotice } = await import('../src/lib/sync')
    const n = registryNotice('created')!
    expect(n).toContain('repositories.yaml')
    expect(n).toContain('other machine')
    expect(n).toContain('--with-registry')
    expect(registryNotice('present')).toBeNull()
  })
})

describe('private registry files travel only when asked', () => {
  it('snapshot create leaves them out by default and carries them with includeRegistry', async () => {
    makeRoot()
    mkdirSync(join(root, '.datacore', 'registry'), { recursive: true })
    writeFileSync(join(root, '.datacore', 'registry', 'repositories.yaml'), 'repositories: {}\n')
    const { createSnapshot } = await import('../src/lib/snapshot')
    expect(createSnapshot().registry).toBeUndefined()
    expect(createSnapshot({ includeRegistry: true }).registry).toEqual({ 'repositories.yaml': 'repositories: {}\n' })
  }, GIT_TIMEOUT)

  it('restore writes a carried registry file only where none exists', async () => {
    makeRoot()
    mkdirSync(join(root, '.datacore', 'registry'), { recursive: true })
    writeFileSync(join(root, '.datacore', 'registry', 'principals.yaml'), 'mine\n')
    const { restoreFromSnapshot } = await import('../src/lib/snapshot')
    const r = restoreFromSnapshot({
      version: '1.0', created: '', cliVersion: '', platform: '', dependencies: [], spaces: [], modules: [],
      registry: { 'repositories.yaml': 'repositories: {}\n', 'principals.yaml': 'theirs\n' },
    })
    expect(r.registryWritten).toEqual(['repositories.yaml'])
    expect(readFileSync(join(root, '.datacore', 'registry', 'principals.yaml'), 'utf-8')).toBe('mine\n')
  }, GIT_TIMEOUT)

  it('restore warns when a template space is in the way of the snapshot copy', async () => {
    makeRoot()
    mkdirSync(join(root, '0-personal', 'org'), { recursive: true })
    const { restoreFromSnapshot } = await import('../src/lib/snapshot')
    const r = restoreFromSnapshot({
      version: '1.0', created: '', cliVersion: '', platform: '', dependencies: [], modules: [],
      spaces: [{ name: '0-personal', number: 0, type: 'personal', source: 'https://example.com/p.git' }],
    })
    expect(r.spacesCreated).toEqual([])
    expect(r.warnings.join('\n')).toContain('NOT restored')
  }, GIT_TIMEOUT)
})
