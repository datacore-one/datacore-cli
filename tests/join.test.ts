/**
 * `datacore join`: make a new machine a mirror of an existing installation.
 *
 * The cases come from the manual second-machine install of 2026-10-23 (a
 * headless Ubuntu server joined to a Mac install). Every step the owner did by
 * hand there is one step here:
 *
 *   1. init --from-snapshot           (clone root, spaces, modules)
 *   2. carry the install-local files  (private registry, *.local.yaml, CLAUDE.local.md)
 *   3. register the machine           (roster entry, owner's hosts/writes_as, identity.env)
 *   4. join the credential store      (owner grants on the store side; never the machine itself)
 *   5. checks and a summary
 *
 * Real git repositories throughout: what git does, not what we believe it does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, chmodSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { parse } from 'yaml'
import {
  DEFAULT_RULES, parseLocalFileRules, localFileRules, collectLocalFiles, scanForSecrets,
  registerMachine, writeIdentity, applyLocalFiles, joinCredentialStore, ownerStoreSteps,
  prepareJoin, runJoin, readBundle, finalChecks, JoinRefusal,
} from '../src/lib/join'
import { restoreFromSnapshot, loadSnapshot } from '../src/lib/snapshot'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@example.com', '-c', 'user.name=T',
    '-c', 'init.defaultBranch=main', ...args],
    { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim()

const INFRA = `# Machine roster (private).
roles:
  always_on: box
servers:
  mac:
    kind: workstation  # a workstation sleeps; that is normal
    ssh_alias: null
    ledger_actors:
    - mac
    access:
      actor: mac
  box:
    kind: server
    ledger_actors: [winston]
    access:
      actor: winston
`
const PRINCIPALS = `version: 1
principals:
  alice:
    kind: human
    decision: final
    hosts: [mac]
    writes_as: [mac]
  winston:
    kind: agent
    hosts: [box]
    writes_as: [winston, bridge]
sprint_sync:
  enabled: true
`
const ROOT_IGNORE = [
  '.datacore/registry/infrastructure.yaml', '.datacore/registry/principals.yaml',
  '.datacore/registry/repositories.yaml', '.datacore/registry/ventures.yaml',
  '*.local.yaml', '*.local.md', 'install.yaml', 'datacore.lock.yaml', '.datacore/secrets/',
  '.datacore/state/', '[1-9]-*/', '0-*/', '.datacore/modules/news/',
].join('\n') + '\n'

/**
 * Fake credential-shaped strings, assembled at runtime so the source itself
 * holds nothing a credential scanner (or a reader) would take for a token.
 */
const fake = (...parts: string[]) => parts.join('')
const FAKE_GH = fake('gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8')
const FAKE_KEY_HEADER = fake('-----BEG', 'IN OPENSSH PRIV', 'ATE KEY-----')
const FAKE_ENV = fake('OPENAI_', 'API', '_KEY=', 's', 'k-pr', 'oj-', 'abcdefghijklmnopqrstuvwx1234')
const FAKE_ANT = fake('s', 'k-an', 't-', 'x'.repeat(40))
const pub = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample dayshift'
let dir = ''
let savedEnv: Record<string, string | undefined> = {}

function setEnv(k: string, v: string | undefined) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k]
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dc-join-'))
  savedEnv = {}
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  setEnv('HOME', home)
  setEnv('DATACORE_ACTOR', undefined)
  setEnv('DATACORE_IDENTITY_FILE', undefined)
})
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(dir, { recursive: true, force: true })
})

function write(path: string, text: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** The existing machine: a root repo with a pushed origin, one space, private files. */
function makeSource(): { root: string; rootUrl: string; spaceUrl: string } {
  const root = join(dir, 'src', 'Data')
  mkdirSync(join(root, '.datacore', 'agents'), { recursive: true })
  write(join(root, '.datacore', 'agents', 'a.md'), 'agent\n')
  write(join(root, '.gitignore'), ROOT_IGNORE)
  write(join(root, 'CLAUDE.base.md'), 'public\n')
  git(dir, 'init', '-q', '-b', 'main', root)
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'root')
  const rootUrl = join(dir, 'root.git')
  git(dir, 'clone', '-q', '--bare', root, rootUrl)
  git(root, 'remote', 'add', 'origin', rootUrl)
  git(root, 'fetch', '-q', 'origin')
  git(root, 'branch', '-q', '--set-upstream-to=origin/main', 'main')

  // a space with its own repo; CLAUDE.local.md ignored there
  const spaceWork = join(dir, 'space-work')
  mkdirSync(spaceWork, { recursive: true })
  write(join(spaceWork, '.gitignore'), '*.local.md\n')
  write(join(spaceWork, 'CLAUDE.base.md'), 'space\n')
  git(dir, 'init', '-q', '-b', 'main', spaceWork)
  git(spaceWork, 'add', '.')
  git(spaceWork, 'commit', '-q', '-m', 'space')
  const spaceUrl = join(dir, 'personal.git')
  git(dir, 'clone', '-q', '--bare', spaceWork, spaceUrl)
  git(dir, 'clone', '-q', spaceUrl, join(root, '0-personal'))

  // private, install-local files
  write(join(root, '.datacore', 'registry', 'infrastructure.yaml'), INFRA)
  write(join(root, '.datacore', 'registry', 'principals.yaml'), PRINCIPALS)
  write(join(root, '.datacore', 'registry', 'repositories.yaml'), 'repositories: {}\n')
  write(join(root, '.datacore', 'registry', 'ventures.yaml'), 'ventures: []\n')
  write(join(root, '.datacore', 'config', 'standup.local.yaml'), 'channel: general\n')
  write(join(root, '.datacore', 'config', 'catalog.local.yaml'), 'extra: true\n')
  write(join(root, '.datacore', 'lib', 'jobs', 'manifest.local.yaml'), 'jobs: []\n')
  write(join(root, 'install.yaml'), 'roles:\n  personal: 0-personal\n  ghost: 9-nowhere\nmodules: [gtd]\n')
  write(join(root, 'CLAUDE.local.md'), '# private root layer\n')
  write(join(root, '0-personal', 'CLAUDE.local.md'), '# private space layer\n')
  setEnv('DATACORE_ROOT', root)
  return { root, rootUrl, spaceUrl }
}

/** A bare credential store with one instance manifest and an install script. */
function makeStore(instances: string[] = ['mac']): string {
  const work = join(dir, 'store-work')
  mkdirSync(join(work, 'instances'), { recursive: true })
  mkdirSync(join(work, 'scripts'), { recursive: true })
  for (const i of instances) write(join(work, 'instances', `${i}.yaml`), `name: ${i}\nprojects: [a]\n`)
  write(join(work, 'scripts', 'install.sh'),
    '#!/usr/bin/env bash\nset -e\nD="$(cd "$(dirname "$0")/.." && pwd)"\n' +
    'test -f "$D/instances/$1.yaml" || { echo "no manifest"; exit 1; }\necho "$1" > "$D/.instance"\necho installed\n')
  chmodSync(join(work, 'scripts', 'install.sh'), 0o755)
  git(dir, 'init', '-q', '-b', 'main', work)
  git(work, 'add', '.')
  git(work, 'commit', '-q', '-m', 'store')
  const bare = join(dir, 'secrets.git')
  git(dir, 'clone', '-q', '--bare', work, bare)
  return bare
}

/** Owner action on the store side: copy the source manifest for the new machine. */
function ownerGrants(name: string, from = 'mac') {
  const work = join(dir, 'store-work')
  write(join(work, 'instances', `${name}.yaml`),
    readFileSync(join(work, 'instances', `${from}.yaml`), 'utf-8').replace(/^name: .*/m, `name: ${name}`))
  git(work, 'add', '.')
  git(work, 'commit', '-q', '-m', `instance ${name}`)
  git(work, 'push', '-q', join(dir, 'secrets.git'), 'main')
}

// ---------------------------------------------------------------------------
describe('which local files travel (reuses local_files_sync.py)', () => {
  it('reads WHOLE / MERGE / ALLOWED from local_files_sync.py when the install has it', () => {
    const py = `WHOLE = [\n    ".datacore/config/a.local.yaml",\n    ".datacore/lib/jobs/manifest.local.yaml",\n]\n` +
      `MERGE = [\n    ".datacore/registry/infrastructure.yaml",\n    "install.yaml",\n]\nNESTED = {"roles"}\n` +
      `ALLOWED = {\n    ".datacore/registry/infrastructure.yaml": {"roles"},\n    "install.yaml": {"roles", "x"},\n}\n`
    const r = parseLocalFileRules(py)!
    expect(r.whole).toEqual(['.datacore/config/a.local.yaml', '.datacore/lib/jobs/manifest.local.yaml'])
    expect(r.merge).toEqual(['.datacore/registry/infrastructure.yaml', 'install.yaml'])
    expect(r.allowed['install.yaml']!.sort()).toEqual(['roles', 'x'])
    expect(r.nested).toEqual(['roles'])
  })

  it('falls back to the built-in copy of the same rules when the script is absent', () => {
    const { root } = makeSource()
    const r = localFileRules(root)
    expect(r.from).toBe('built-in')
    expect(r.whole).toEqual(DEFAULT_RULES.whole)
    expect(r.merge).toContain('install.yaml')
  })

  it('uses the script in the install over the built-in copy', () => {
    const { root } = makeSource()
    write(join(root, '.datacore', 'lib', 'local_files_sync.py'),
      'WHOLE = [\n    ".datacore/config/only.local.yaml",\n]\nMERGE = [\n    "install.yaml",\n]\nALLOWED = {\n    "install.yaml": {"roles"},\n}\n')
    const r = localFileRules(root)
    expect(r.from).toBe('local_files_sync.py')
    expect(r.whole).toEqual(['.datacore/config/only.local.yaml'])
  })

  it('collects gitignored local files, the private registry and every CLAUDE.local.md; never tracked files', () => {
    const { root } = makeSource()
    // a tracked file that happens to be named like a local one: git carries it, the bundle must not
    write(join(root, '.datacore', 'config', 'tracked.local.yaml'), 'x: 1\n')
    git(root, 'add', '-f', '.datacore/config/tracked.local.yaml')
    git(root, 'commit', '-q', '-m', 'tracked')
    const { files } = collectLocalFiles(root, localFileRules(root))
    const keys = Object.keys(files)
    expect(keys).toContain('.datacore/config/standup.local.yaml')
    expect(keys).toContain('.datacore/config/catalog.local.yaml')   // the *.local.yaml glob, beyond the script's list
    expect(keys).toContain('.datacore/lib/jobs/manifest.local.yaml')
    expect(keys).toContain('.datacore/registry/ventures.yaml')
    expect(keys).toContain('install.yaml')
    expect(keys).toContain('CLAUDE.local.md')
    expect(keys).toContain('0-personal/CLAUDE.local.md')
    expect(keys).not.toContain('.datacore/config/tracked.local.yaml')
    expect(keys.some((k) => k.includes('secrets') || k.endsWith('.env'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
describe('no secrets in the bundle', () => {
  it('finds tokens and private keys, and names file and line but never the value', () => {
    const token = FAKE_GH
    const hits = scanForSecrets({
      'CLAUDE.local.md': `# notes\nmy token ${token}\n`,
      'x.local.yaml': `k: v\n${FAKE_KEY_HEADER}\n`,
      '.env-like.local.yaml': `${FAKE_ENV}\n`,
      'clean.yaml': 'token_env: TELEGRAM_BOT_TOKEN\napi_key_var: ANTHROPIC_KEY_NAME\nemail_sha256: 0123456789abcdef\n',
    })
    expect(hits.map((h) => `${h.file}:${h.line}`).sort())
      .toEqual(['.env-like.local.yaml:1', 'CLAUDE.local.md:2', 'x.local.yaml:2'])
    expect(JSON.stringify(hits)).not.toContain(token)
  })

  it('prepare refuses to write a bundle when a carried file holds a secret', () => {
    const { root } = makeSource()
    write(join(root, 'CLAUDE.local.md'), `deploy with ${FAKE_ANT}\n`)
    const out = join(dir, 'b.yaml')
    expect(() => prepareJoin({ root, name: 'dayshift', output: out })).toThrow(JoinRefusal)
    expect(existsSync(out)).toBe(false)
    // and nothing was registered either: the refusal comes before any change
    expect(readFileSync(join(root, '.datacore', 'registry', 'infrastructure.yaml'), 'utf-8')).toBe(INFRA)
  })
})

// ---------------------------------------------------------------------------
describe('registering the machine', () => {
  it('adds a workstation roster entry with its own actor and the owner\'s hosts/writes_as, keeping comments', () => {
    const { root } = makeSource()
    const r = registerMachine(root, { name: 'dayshift', actor: 'dayshift' })
    expect(r.owner).toBe('alice')
    const infraText = readFileSync(join(root, '.datacore', 'registry', 'infrastructure.yaml'), 'utf-8')
    expect(infraText).toContain('# Machine roster (private).')
    expect(infraText).toContain('# a workstation sleeps; that is normal')
    const infra = parse(infraText)
    expect(infra.servers.dayshift.kind).toBe('workstation')
    expect(infra.servers.dayshift.ssh_alias).toBe('dayshift')
    expect(infra.servers.dayshift.ledger_actors).toEqual(['dayshift'])
    expect(infra.servers.dayshift.access.actor).toBe('dayshift')
    const p = parse(readFileSync(join(root, '.datacore', 'registry', 'principals.yaml'), 'utf-8'))
    expect(p.principals.alice.hosts).toEqual(['mac', 'dayshift'])
    expect(p.principals.alice.writes_as).toEqual(['mac', 'dayshift'])
    expect(p.principals.winston.writes_as).toEqual(['winston', 'bridge'])
  })

  it('is idempotent: registering the same machine again changes nothing', () => {
    const { root } = makeSource()
    registerMachine(root, { name: 'dayshift', actor: 'dayshift' })
    const before = readFileSync(join(root, '.datacore', 'registry', 'principals.yaml'), 'utf-8')
    const r = registerMachine(root, { name: 'dayshift', actor: 'dayshift' })
    expect(r.changed).toEqual([])
    expect(readFileSync(join(root, '.datacore', 'registry', 'principals.yaml'), 'utf-8')).toBe(before)
  })

  it('refuses an actor another machine already writes as (two machines, one log, a fork)', () => {
    const { root } = makeSource()
    expect(() => registerMachine(root, { name: 'dayshift', actor: 'winston' })).toThrow(/already writes as|already/)
    expect(() => registerMachine(root, { name: 'dayshift', actor: 'bridge' })).toThrow(JoinRefusal)
    expect(() => registerMachine(root, { name: 'dayshift', actor: 'mac' })).toThrow(JoinRefusal)
    expect(readFileSync(join(root, '.datacore', 'registry', 'infrastructure.yaml'), 'utf-8')).toBe(INFRA)
    expect(readFileSync(join(root, '.datacore', 'registry', 'principals.yaml'), 'utf-8')).toBe(PRINCIPALS)
  })

  it('refuses a machine name already on the roster under another actor', () => {
    const { root } = makeSource()
    expect(() => registerMachine(root, { name: 'box', actor: 'box2' })).toThrow(JoinRefusal)
  })

  it('refuses to edit a roster that does not parse, instead of making it worse', () => {
    const { root } = makeSource()
    const broken = INFRA + '  dayshift:\n    notes: Set up (log: see a: b)\n'
    write(join(root, '.datacore', 'registry', 'infrastructure.yaml'), broken)
    expect(() => registerMachine(root, { name: 'other', actor: 'other' })).toThrow(/does not parse/)
    expect(readFileSync(join(root, '.datacore', 'registry', 'infrastructure.yaml'), 'utf-8')).toBe(broken)
  })

  it('refuses invalid names', () => {
    const { root } = makeSource()
    expect(() => registerMachine(root, { name: 'Bad Name', actor: 'x' })).toThrow(JoinRefusal)
    expect(() => registerMachine(root, { name: 'ok', actor: '../x' })).toThrow(JoinRefusal)
  })

  it('writes identity.env, keeps it when it already says the same, refuses a different actor', () => {
    const file = join(process.env.HOME!, '.datacore', 'identity.env')
    expect(writeIdentity('dayshift')).toBe('written')
    expect(readFileSync(file, 'utf-8')).toContain('DATACORE_ACTOR=dayshift')
    expect(statSync(file).mode & 0o077).toBe(0)
    expect(writeIdentity('dayshift')).toBe('present')
    expect(() => writeIdentity('other')).toThrow(JoinRefusal)
    expect(readFileSync(file, 'utf-8')).toContain('DATACORE_ACTOR=dayshift')
    expect(readFileSync(file, 'utf-8')).not.toContain('other')
  })
})

// ---------------------------------------------------------------------------
describe('applying local files on the new machine', () => {
  function target(): string {
    const { rootUrl, spaceUrl } = makeSource()
    const t = join(dir, 'new', 'Data')
    git(dir, 'clone', '-q', rootUrl, t)
    git(dir, 'clone', '-q', spaceUrl, join(t, '0-personal'))
    return t
  }

  it('writes what the machine lacks and never overwrites a file it already has', () => {
    const t = target()
    write(join(t, '.datacore', 'config', 'standup.local.yaml'), 'channel: mine\n')
    const files = {
      '.datacore/config/standup.local.yaml': 'channel: general\n',
      '.datacore/config/catalog.local.yaml': 'extra: true\n',
      '0-personal/CLAUDE.local.md': '# private space layer\n',
    }
    const rep = applyLocalFiles(t, files, DEFAULT_RULES)
    expect(readFileSync(join(t, '.datacore', 'config', 'standup.local.yaml'), 'utf-8')).toBe('channel: mine\n')
    expect(rep.kept).toContain('.datacore/config/standup.local.yaml')
    expect(rep.written).toContain('.datacore/config/catalog.local.yaml')
    expect(rep.written).toContain('0-personal/CLAUDE.local.md')
    expect(statSync(join(t, '.datacore', 'config', 'catalog.local.yaml')).mode & 0o077).toBe(0)
  })

  it('merges only the allowed keys a machine lacks, roles key by key, roles only for spaces it has', () => {
    const t = target()
    write(join(t, 'install.yaml'), '# mine\nroles:\n  work: 0-personal\nmodules: [mine]\n')
    write(join(t, '.datacore', 'registry', 'principals.yaml'), 'version: 1\nprincipals: {}\n')
    const rep = applyLocalFiles(t, {
      'install.yaml': 'roles:\n  work: 0-other\n  personal: 0-personal\n  ghost: 9-nowhere\nmodules: [gtd]\n',
      '.datacore/registry/principals.yaml': PRINCIPALS,
    }, DEFAULT_RULES)
    const inst = readFileSync(join(t, 'install.yaml'), 'utf-8')
    expect(inst).toContain('# mine')
    const y = parse(inst)
    expect(y.roles.work).toBe('0-personal')          // its own value kept
    expect(y.roles.personal).toBe('personal')         // added, as the bare space name
    expect(y.roles.ghost).toBeUndefined()             // no such space here
    expect(y.modules).toEqual(['mine'])               // not an allowed key: untouched
    const p = parse(readFileSync(join(t, '.datacore', 'registry', 'principals.yaml'), 'utf-8'))
    expect(p.sprint_sync).toEqual({ enabled: true })  // allowed, missing: added
    expect(p.principals).toEqual({})                  // its own: untouched
    expect(rep.merged.length).toBe(2)
  })

  it('refuses a file the repository would commit', () => {
    const t = target()
    const rep = applyLocalFiles(t, { 'notes/leak.local.txt': 'x\n' }, DEFAULT_RULES)
    expect(rep.refused[0]).toContain('notes/leak.local.txt')
    expect(existsSync(join(t, 'notes', 'leak.local.txt'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
describe('credential store: the owner grants, the machine never grants itself', () => {

  it('owner steps copy the SOURCE instance manifest and authorise the printed key', () => {
    const steps = ownerStoreSteps({ name: 'dayshift', sourceInstance: 'local', publicKey: pub, remote: 'me@store:~/secrets.git' }).join('\n')
    expect(steps).toContain('instances/local.yaml')
    expect(steps).toContain('instances/dayshift.yaml')
    expect(steps).toContain(pub)
    expect(steps).toContain('git push')
  })

  it('an unreachable store: waits for the owner, clones nothing, writes nothing to the store', async () => {
    const root = join(dir, 'Data'); mkdirSync(root, { recursive: true })
    const r = await joinCredentialStore(root, { name: 'dayshift', sourceInstance: 'mac', remote: join(dir, 'missing.git') },
      { publicKey: () => pub })
    expect(r.status).toBe('waiting-for-owner')
    expect(r.ownerSteps.join('\n')).toContain(pub)
    expect(existsSync(join(root, '.datacore', 'secrets'))).toBe(false)
  })

  it('a reachable store without this machine\'s manifest: waits; the manifest is never created here', async () => {
    const store = makeStore(['mac'])
    const before = git(dir, '--git-dir', store, 'rev-parse', 'main')
    const root = join(dir, 'Data'); mkdirSync(root, { recursive: true })
    const r = await joinCredentialStore(root, { name: 'dayshift', sourceInstance: 'mac', remote: store }, { publicKey: () => pub })
    expect(r.status).toBe('waiting-for-owner')
    expect(existsSync(join(root, '.datacore', 'secrets', 'instances', 'dayshift.yaml'))).toBe(false)
    expect(git(dir, '--git-dir', store, 'rev-parse', 'main')).toBe(before)
  })

  it('once the owner has granted: clones, runs install, creds sync and creds doctor', async () => {
    const store = makeStore(['mac'])
    ownerGrants('dayshift')
    const root = join(dir, 'Data'); mkdirSync(root, { recursive: true })
    const ran: string[] = []
    const r = await joinCredentialStore(root, { name: 'dayshift', sourceInstance: 'mac', remote: store }, {
      publicKey: () => pub,
      creds: (args) => { ran.push(args.join(' ')); return { status: 0, stdout: args[0] === 'doctor' ? 'ok  A\nok  B\n' : '', stderr: '' } },
    })
    expect(r.status).toBe('done')
    expect(readFileSync(join(root, '.datacore', 'secrets', '.instance'), 'utf-8').trim()).toBe('dayshift')
    expect(ran).toEqual(['sync', 'doctor'])
    expect(r.doctor).toEqual({ ok: 2, fail: 0, na: 0 })
  })

  it('a waiting run picks up where it stopped once the owner has pushed the manifest', async () => {
    const store = makeStore(['mac'])
    const root = join(dir, 'Data'); mkdirSync(root, { recursive: true })
    const deps = { publicKey: () => pub, creds: () => ({ status: 0, stdout: 'ok A\n', stderr: '' }) }
    expect((await joinCredentialStore(root, { name: 'dayshift', sourceInstance: 'mac', remote: store }, deps)).status).toBe('waiting-for-owner')
    ownerGrants('dayshift')
    expect((await joinCredentialStore(root, { name: 'dayshift', sourceInstance: 'mac', remote: store }, deps)).status).toBe('done')
  })
})

// ---------------------------------------------------------------------------
describe('join --prepare (the existing machine) and join (the new one)', () => {
  it('prepare: registers the machine on the source and writes one mode-600 bundle without secrets', () => {
    const { root } = makeSource()
    const out = join(dir, 'out', 'dayshift.join.yaml')
    const r = prepareJoin({ root, name: 'dayshift', output: out })
    expect(statSync(out).mode & 0o077).toBe(0)
    const b = readBundle(out)
    expect(b.machine).toEqual({ name: 'dayshift', actor: 'dayshift', owner: 'alice' })
    expect(Object.keys(b.snapshot.registry ?? {})).toContain('repositories.yaml')
    expect(parse(b.snapshot.registry!['infrastructure.yaml']!).servers.dayshift.access.actor).toBe('dayshift')
    expect(b.files['0-personal/CLAUDE.local.md']).toBe('# private space layer\n')
    expect(scanForSecrets({ bundle: readFileSync(out, 'utf-8') })).toEqual([])
    expect(r.command).toContain('join')
    expect(r.command).toContain('dayshift.join.yaml')
    // the source side records the new machine too
    expect(parse(readFileSync(join(root, '.datacore', 'registry', 'principals.yaml'), 'utf-8')).principals.alice.hosts)
      .toContain('dayshift')
  })

  it('prepare refuses the source machine\'s own actor', () => {
    const { root } = makeSource()
    setEnv('DATACORE_ACTOR', 'mac')
    expect(() => prepareJoin({ root, name: 'mac2', actor: 'mac', output: join(dir, 'x.yaml') })).toThrow(JoinRefusal)
  })

  it('join: init from the bundle, local files, registry, identity, store, checks', async () => {
    const { root: src } = makeSource()
    const store = makeStore(['local'])
    git(dir, 'clone', '-q', store, join(src, '.datacore', 'secrets'))
    writeFileSync(join(src, '.datacore', 'secrets', '.instance'), 'local\n')
    const out = join(dir, 'dayshift.join.yaml')
    prepareJoin({ root: src, name: 'dayshift', output: out })
    ownerGrants('dayshift', 'local')

    // the new machine
    const t = join(dir, 'new', 'Data')
    setEnv('HOME', join(dir, 'newhome'))
    mkdirSync(process.env.HOME!, { recursive: true })
    setEnv('DATACORE_ROOT', t)
    const credsRan: string[] = []
    const r = await runJoin(out, {
      initialized: () => existsSync(join(t, '.git')),
      init: async (lockPath) => {
        // what init --from-snapshot does, minus dependency installs
        const snap = loadSnapshot(lockPath)!
        git(dir, 'clone', '-q', snap.root!.source!, t)
        const res = restoreFromSnapshot(snap)
        return { ok: true, errors: [], warnings: res.warnings }
      },
      doctor: () => ({ ok: true, message: 'System ready for Datacore' }),
      publicKey: () => pub,
      creds: (args) => { credsRan.push(args[0]!); return { status: 0, stdout: 'ok A\n', stderr: '' } },
      contextRebuild: () => true,
    })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(process.env.HOME!, '.datacore', 'identity.env'), 'utf-8')).toContain('DATACORE_ACTOR=dayshift')
    expect(existsSync(join(t, '0-personal', '.git'))).toBe(true)
    expect(readFileSync(join(t, '0-personal', 'CLAUDE.local.md'), 'utf-8')).toBe('# private space layer\n')
    expect(readFileSync(join(t, 'CLAUDE.local.md'), 'utf-8')).toBe('# private root layer\n')
    expect(existsSync(join(t, '.datacore', 'registry', 'repositories.yaml'))).toBe(true)
    expect(parse(readFileSync(join(t, '.datacore', 'registry', 'infrastructure.yaml'), 'utf-8')).servers.dayshift.access.actor)
      .toBe('dayshift')
    expect(readFileSync(join(t, '.datacore', 'secrets', '.instance'), 'utf-8').trim()).toBe('dayshift')
    expect(credsRan).toEqual(['sync', 'doctor'])
    const names = r.checks.map((c) => `${c.name}:${c.ok}`)
    expect(names).toContain('identity:true')
    expect(names).toContain('branches:true')
    expect(names).toContain('spaces clean:true')
    expect(names).toContain('doctor:true')
    expect(r.ownerTodo).toEqual([])
  })

  it('join refuses before changing anything when this machine already writes as someone else', async () => {
    const { root: src } = makeSource()
    const out = join(dir, 'dayshift.join.yaml')
    prepareJoin({ root: src, name: 'dayshift', output: out })
    setEnv('HOME', join(dir, 'newhome'))
    write(join(process.env.HOME!, '.datacore', 'identity.env'), 'DATACORE_ACTOR=mac\n')
    const t = join(dir, 'new', 'Data')
    setEnv('DATACORE_ROOT', t)
    let initRan = false
    await expect(runJoin(out, {
      initialized: () => false,
      init: async () => { initRan = true; return { ok: true, errors: [], warnings: [] } },
      doctor: () => ({ ok: true, message: '' }),
    })).rejects.toThrow(JoinRefusal)
    expect(initRan).toBe(false)
    expect(readFileSync(join(process.env.HOME!, '.datacore', 'identity.env'), 'utf-8')).toBe('DATACORE_ACTOR=mac\n')
  })

  it('join without a credential store on the source skips that step and says so', async () => {
    const { root: src } = makeSource()
    const out = join(dir, 'dayshift.join.yaml')
    prepareJoin({ root: src, name: 'dayshift', output: out })
    const t = join(dir, 'new', 'Data')
    setEnv('HOME', join(dir, 'newhome'))
    mkdirSync(process.env.HOME!, { recursive: true })
    setEnv('DATACORE_ROOT', t)
    const r = await runJoin(out, {
      initialized: () => existsSync(join(t, '.git')),
      init: async (lockPath) => {
        const snap = loadSnapshot(lockPath)!
        git(dir, 'clone', '-q', snap.root!.source!, t)
        return { ok: true, errors: [], warnings: restoreFromSnapshot(snap).warnings }
      },
      doctor: () => ({ ok: true, message: '' }),
      contextRebuild: () => true,
    })
    expect(r.credentials.status).toBe('skipped')
    expect(r.ok).toBe(true)
  })

  it('finalChecks flags a detached or dirty space', () => {
    const { root } = makeSource()
    write(join(root, '.datacore', 'state', 'x'), '')
    writeFileSync(join(root, '0-personal', 'CLAUDE.base.md'), 'changed\n')
    setEnv('DATACORE_IDENTITY_FILE', join(dir, 'id.env'))
    writeFileSync(join(dir, 'id.env'), 'DATACORE_ACTOR=dayshift\n')
    const c = finalChecks(root, 'dayshift', () => ({ ok: true, message: '' }))
    expect(c.find((x) => x.name === 'identity')!.ok).toBe(true)
    expect(c.find((x) => x.name === 'spaces clean')!.ok).toBe(false)
    expect(c.find((x) => x.name === 'spaces clean')!.detail).toContain('0-personal')
  })

  it('prepare (also --dry-run) refuses a registry file that does not parse, says which and where, changes nothing', () => {
    const { root } = makeSource()
    const broken = INFRA + '  dayshift:\n    notes: Set up (log: see a: b)\n'
    write(join(root, '.datacore', 'registry', 'infrastructure.yaml'), broken)
    for (const dryRun of [true, false]) {
      const out = join(dir, `b-${dryRun}.yaml`)
      expect(() => prepareJoin({ root, name: 'other', output: out, dryRun })).toThrow(/infrastructure\.yaml does not parse \(line \d+\)/)
      expect(existsSync(out)).toBe(false)
    }
    expect(readFileSync(join(root, '.datacore', 'registry', 'infrastructure.yaml'), 'utf-8')).toBe(broken)
    expect(readFileSync(join(root, '.datacore', 'registry', 'principals.yaml'), 'utf-8')).toBe(PRINCIPALS)
  })

  it('join refuses before any change when the bundle\'s or this machine\'s registry does not parse', async () => {
    const { root: src } = makeSource()
    const out = join(dir, 'dayshift.join.yaml')
    prepareJoin({ root: src, name: 'dayshift', output: out })
    const t = join(dir, 'new', 'Data')
    setEnv('HOME', join(dir, 'newhome'))
    mkdirSync(process.env.HOME!, { recursive: true })
    setEnv('DATACORE_ROOT', t)
    let initRan = false
    const deps = {
      initialized: () => existsSync(join(t, '.git')),
      init: async () => { initRan = true; return { ok: true, errors: [], warnings: [] } },
      doctor: () => ({ ok: true, message: '' }),
    }

    // (1) the bundle carries a roster that does not parse
    const b = parse(readFileSync(out, 'utf-8'))
    b.snapshot.registry['principals.yaml'] = 'principals:\n  alice:\n    notes: a: b: c\n'
    const badBundle = join(dir, 'bad.join.yaml')
    writeFileSync(badBundle, (await import('yaml')).stringify(b), { mode: 0o600 })
    await expect(runJoin(badBundle, deps)).rejects.toThrow(/principals\.yaml.*does not parse/)
    expect(initRan).toBe(false)

    // (2) this machine already has a roster, and it does not parse
    const broken = 'servers:\n  x:\n    notes: Set up (log: see a: b)\n'
    write(join(t, '.datacore', 'registry', 'infrastructure.yaml'), broken)
    await expect(runJoin(out, deps)).rejects.toThrow(/infrastructure\.yaml.*does not parse/)
    expect(initRan).toBe(false)
    expect(readFileSync(join(t, '.datacore', 'registry', 'infrastructure.yaml'), 'utf-8')).toBe(broken)
    expect(existsSync(join(process.env.HOME!, '.datacore', 'identity.env'))).toBe(false)
  })

  it('finalChecks flags a module left on a detached HEAD', () => {
    const { root, spaceUrl } = makeSource()
    const mod = join(root, '.datacore', 'modules', 'news')
    git(dir, 'clone', '-q', spaceUrl, mod)
    git(mod, 'checkout', '-q', '--detach', 'HEAD')
    const c = finalChecks(root, 'dayshift', () => ({ ok: true, message: '' }))
    expect(c.find((x) => x.name === 'branches')!.ok).toBe(false)
    expect(c.find((x) => x.name === 'branches')!.detail).toContain('module news')
  })
})
