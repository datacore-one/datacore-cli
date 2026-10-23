/**
 * `datacore join`: make a new machine a mirror of an existing installation --
 * the same person, the same access, so sessions there behave the same.
 *
 * Everything here automates what the owner did by hand on 2026-10-23 to join
 * a headless server to his Mac install, in the same order:
 *
 *   on the existing machine   datacore join --prepare <new-machine>
 *     - registers the new machine in the private roster and as one of the
 *       owner's writers (refusing an actor another machine already writes as:
 *       two machines appending as one actor fork its per-writer log)
 *     - writes ONE bundle (mode 600, scanned for secrets): the snapshot with the
 *       private registry, plus the gitignored install-local files
 *
 *   on the new machine        datacore join <bundle>
 *     1. init --from-snapshot (root, spaces, modules on their branches)
 *     2. the install-local files, with local_files_sync.py's rules: a file the
 *        machine already has is never overwritten
 *     3. the same registration, and ~/.datacore/identity.env
 *     4. the credential store -- but only after the OWNER grants access on the
 *        store side. The machine never grants itself anything: it prints what
 *        the owner must do and waits.
 *     5. checks and a summary of what is done and what the owner still owes
 *
 * Secret values never pass through here: the bundle is scanned before it is
 * written, and the credential tools' output is reduced to ok/FAIL counts.
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync, copyFileSync, statSync, rmSync,
} from 'fs'
import { join, dirname, basename, isAbsolute } from 'path'
import { hostname, tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { parse, parseDocument, stringify, isMap, isSeq, Document } from 'yaml'
import { homeDir } from './exec'
import { dataDir } from './paths'
import { createSnapshot, restoreFromSnapshot, PRIVATE_REGISTRY_FILES, type Snapshot } from './snapshot'
import { getRepoStatus } from './sync'
import { reattach, isDetached } from './gitbranch'
import { VERSION } from '../version'

/** A refusal: the command stops and nothing further is changed. */
export class JoinRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JoinRefusal'
  }
}

// ---------------------------------------------------------------------------
// Which install-local files travel, and how they land.
//
// The Datacore root ships .datacore/lib/local_files_sync.py, which already
// decides this for pushing local files to a fleet host over ssh. Its lists are
// the source of truth: when the installation has the script, its WHOLE / MERGE
// / ALLOWED are read from it, so the two cannot drift. The copy below is only
// for an installation that predates it.

export interface LocalFileRules {
  /** Copied as they are when the machine has none; never overwritten. */
  whole: string[]
  /** Every machine has its own; only allowed top-level keys it lacks are added. */
  merge: string[]
  /** Mappings merged key by key instead of as a whole. */
  nested: string[]
  /** Per MERGE file, the only top-level keys that ever travel. */
  allowed: Record<string, string[]>
  /** Its role values name space folders: keep only spaces the machine has. */
  spaceRolesFile: string
}

export const DEFAULT_RULES: LocalFileRules = {
  whole: [
    '.datacore/config/approvals_policy.local.yaml',
    '.datacore/config/task-themes.local.yaml',
    '.datacore/lib/jobs/manifest.local.yaml',
    '.datacore/config/authorship-reviewed.local.yaml',
    '.datacore/config/ledger-invariants-baseline.local.yaml',
    '.datacore/config/gh-reconcile.local.yaml',
    '.datacore/config/standup.local.yaml',
    '.datacore/config/publish-scrub.local.yaml',
  ],
  merge: ['.datacore/registry/infrastructure.yaml', '.datacore/registry/principals.yaml', 'install.yaml'],
  nested: ['roles'],
  allowed: {
    '.datacore/registry/infrastructure.yaml': ['roles'],
    '.datacore/registry/principals.yaml': ['sprint_sync', 'delegation_exercise', 'cross_model_audit', 'testnet_dashboard'],
    'install.yaml': ['roles'],
  },
  spaceRolesFile: 'install.yaml',
}

/** Private registry files beyond the snapshot's three; carried only when gitignored. */
const EXTRA_REGISTRY_FILES = ['deliverables.yaml', 'ventures.yaml', 'agents.local.yaml', 'commands.local.yaml']

function pyStrings(body: string): string[] {
  return [...body.matchAll(/["']([^"'\n]+)["']/g)].map((m) => m[1]!)
}

/** Read WHOLE / MERGE / NESTED / ALLOWED out of local_files_sync.py. Null if it does not have them. */
export function parseLocalFileRules(py: string): LocalFileRules | null {
  const list = (name: string) => {
    const m = py.match(new RegExp(`^${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm'))
    return m ? pyStrings(m[1]!) : null
  }
  const whole = list('WHOLE')
  const merge = list('MERGE')
  const allowedBlock = py.match(/^ALLOWED\s*=\s*\{([\s\S]*?)^\}/m)
  if (!whole || !merge || !allowedBlock) return null
  const allowed: Record<string, string[]> = {}
  for (const m of allowedBlock[1]!.matchAll(/["']([^"'\n]+)["']\s*:\s*\{([^}]*)\}/g)) allowed[m[1]!] = pyStrings(m[2]!)
  const nestedM = py.match(/^NESTED\s*=\s*\{([^}]*)\}/m)
  const rolesM = py.match(/^SPACE_ROLES_FILE\s*=\s*["']([^"']+)["']/m)
  return {
    whole,
    merge,
    allowed,
    nested: nestedM ? pyStrings(nestedM[1]!) : DEFAULT_RULES.nested,
    spaceRolesFile: rolesM ? rolesM[1]! : DEFAULT_RULES.spaceRolesFile,
  }
}

export function localFileRules(root: string): LocalFileRules & { from: 'local_files_sync.py' | 'built-in' } {
  const py = join(root, '.datacore', 'lib', 'local_files_sync.py')
  if (existsSync(py)) {
    try {
      const r = parseLocalFileRules(readFileSync(py, 'utf-8'))
      if (r) return { ...r, from: 'local_files_sync.py' }
    } catch { /* fall through to the built-in copy */ }
  }
  return { ...DEFAULT_RULES, from: 'built-in' }
}

// ---------------------------------------------------------------------------
// Which repository a path belongs to, and whether that repository would commit it.

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): { ok: boolean; out: string; err: string; status: number } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env: env ?? process.env, timeout: 300000 })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), status: r.status ?? -1 }
}

function repoFor(root: string, rel: string): { repo: string; rel: string } {
  const [first, ...rest] = rel.split('/')
  if (first && /^\d+-/.test(first) && rest.length && existsSync(join(root, first, '.git'))) {
    return { repo: join(root, first), rel: rest.join('/') }
  }
  return { repo: root, rel }
}

/**
 * 'ignored' is the only verdict under which a private file may be written: a
 * tracked or merely untracked one would be committed and pushed by the next
 * sync. Same rule as local_files_sync.py's REFUSE.
 */
export function repoVerdict(root: string, rel: string): 'ignored' | 'tracked' | 'exposed' | 'no repository' {
  const { repo, rel: r } = repoFor(root, rel)
  if (!existsSync(join(repo, '.git'))) return 'no repository'
  if (git(repo, ['ls-files', '--error-unmatch', '--', r]).ok) return 'tracked'
  if (git(repo, ['check-ignore', '-q', '--', r]).ok) return 'ignored'
  return 'exposed'
}

function safeRel(rel: string): boolean {
  return !!rel && !isAbsolute(rel) && !rel.split(/[\\/]/).includes('..') && !rel.includes('\0')
}

const NEVER_CARRY = /(^|\/)\.datacore\/(secrets|env)\/|(^|\/)[^/]*\.env$/

function spaceDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+-/.test(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** Gather the install-local files this machine has and git does not carry. */
export function collectLocalFiles(root: string, rules: LocalFileRules): { files: Record<string, string>; skipped: string[] } {
  const candidates = new Set<string>([...rules.whole, ...rules.merge])
  const configDir = join(root, '.datacore', 'config')
  if (existsSync(configDir)) {
    for (const f of readdirSync(configDir).sort()) if (f.endsWith('.local.yaml')) candidates.add(`.datacore/config/${f}`)
  }
  for (const f of [...PRIVATE_REGISTRY_FILES, ...EXTRA_REGISTRY_FILES]) candidates.add(`.datacore/registry/${f}`)
  candidates.add('CLAUDE.local.md')
  for (const s of spaceDirs(root)) candidates.add(`${s}/CLAUDE.local.md`)

  const files: Record<string, string> = {}
  const skipped: string[] = []
  for (const rel of candidates) {
    if (NEVER_CARRY.test(rel)) continue
    const abs = join(root, rel)
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) continue
    } catch {
      continue
    }
    const verdict = repoVerdict(root, rel)
    if (verdict !== 'ignored') {
      skipped.push(`${rel}: ${verdict} (${verdict === 'tracked' ? 'git carries it' : 'not gitignored, so not treated as private'})`)
      continue
    }
    files[rel] = readFileSync(abs, 'utf-8')
  }
  return { files, skipped }
}

// ---------------------------------------------------------------------------
// Secret scan. A hit names the file, the line and the kind -- never the value.

export interface SecretHit { file: string; line: number; kind: string }

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/, 'private key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'GitHub token'],
  [/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/, 'API key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/, 'Telegram bot token'],
  [/:\/\/[^/\s:@]+:[^/\s@]{6,}@/, 'password in a URL'],
]
const ENV_ASSIGN = /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*["']?([^\s"'#]+)/
const YAML_ASSIGN = /^\s*[A-Za-z_]*(?:token|secret|password|passwd|api_key|apikey)\s*:\s*["']?([^\s"'#]+)/i

function looksLikeValue(v: string, min: number): boolean {
  if (v.length < min) return false
  if (/^[A-Z0-9_]+$/.test(v)) return false            // a variable NAME, e.g. TELEGRAM_BOT_TOKEN
  if (v.startsWith('$') || v.startsWith('<') || v.startsWith('~') || v.startsWith('/')) return false
  if (/^(null|none|true|false|changeme|redacted)$/i.test(v)) return false
  return /[A-Za-z]/.test(v) && /[0-9]/.test(v)
}

export function scanForSecrets(files: Record<string, string>): SecretHit[] {
  const hits: SecretHit[] = []
  for (const [file, text] of Object.entries(files)) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!
      let kind: string | null = null
      for (const [re, k] of SECRET_PATTERNS) if (re.test(l)) { kind = k; break }
      if (!kind) {
        const e = l.match(ENV_ASSIGN)
        if (e && looksLikeValue(e[1]!, 12)) kind = 'credential assignment'
      }
      if (!kind) {
        const y = l.match(YAML_ASSIGN)
        if (y && looksLikeValue(y[1]!, 20)) kind = 'credential value'
      }
      if (kind) hits.push({ file, line: i + 1, kind })
    }
  }
  return hits
}

function refuseOnSecrets(hits: SecretHit[]): void {
  if (!hits.length) return
  throw new JoinRefusal(
    `refusing to write the bundle: ${hits.length} line(s) look like a secret value, and a secret never travels in it ` +
    `(credentials go through the credential store):\n` +
    hits.map((h) => `  ${h.file}:${h.line}  ${h.kind}`).join('\n') +
    '\nMove the value into the credential store (creds add), then run this again.')
}

// ---------------------------------------------------------------------------
// Registration: the roster entry, the owner's writers, identity.env.

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/

function validateName(v: string, what: string): void {
  if (!NAME_RE.test(v)) {
    throw new JoinRefusal(`${what} "${v}" is not valid: use lowercase letters, digits and dashes, starting with a letter`)
  }
}

export function shortHostname(): string {
  return hostname().split('.')[0]!.toLowerCase()
}

function loadDoc(path: string, label: string): Document | null {
  if (!existsSync(path)) return null
  const doc = parseDocument(readFileSync(path, 'utf-8'))
  if (doc.errors.length) {
    const e = doc.errors[0]!
    const line = e.linePos?.[0]?.line
    throw new JoinRefusal(`${label} does not parse${line ? ` (line ${line})` : ''}: ${e.code}. ` +
      'Fix the file first; it is not edited while it is broken.')
  }
  return doc
}

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x))
  if (typeof v === 'string' && v) return [v]
  return []
}

function backupDir(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
  return join(homeDir(), '.datacore', 'state', `local-files-backup-${stamp}`)
}

function backup(abs: string, bk: string): void {
  if (!existsSync(abs)) return
  const dest = join(bk, abs.replace(/^[A-Za-z]:/, '').replace(/^[\\/]+/, ''))
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(abs, dest)
}

function writePrivate(abs: string, text: string): void {
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text, { mode: 0o600 })
  try { chmodSync(abs, 0o600) } catch { /* not POSIX */ }
}

export interface RegisterResult {
  owner?: string
  /** What changed, e.g. "infrastructure.yaml: servers.dayshift". Empty when already registered. */
  changed: string[]
  notes: string[]
}

/**
 * Put `name` on the roster with its own ledger actor and make it one of the
 * owner's hosts and writers. Refuses before writing anything when the actor is
 * already somebody else's, the name is on the roster under another actor, or a
 * registry file does not parse. Registering the same machine again is a no-op.
 */
export function registerMachine(
  root: string,
  opts: { name: string; actor: string; owner?: string },
  mode: { write?: boolean } = {},
): RegisterResult {
  const { name, actor } = opts
  validateName(name, 'machine name')
  validateName(actor, 'actor')
  const regDir = join(root, '.datacore', 'registry')
  const infraPath = join(regDir, 'infrastructure.yaml')
  const princPath = join(regDir, 'principals.yaml')
  const infraDoc = loadDoc(infraPath, 'infrastructure.yaml') ?? new Document({ servers: {} })
  const princDoc = loadDoc(princPath, 'principals.yaml')
  const infra = (infraDoc.toJS() ?? {}) as { servers?: Record<string, any> }
  const servers = infra.servers ?? {}
  const principals = ((princDoc?.toJS() ?? {}) as { principals?: Record<string, any> }).principals ?? {}

  const mine = servers[name]
  const mineActor = mine?.access?.actor ? String(mine.access.actor).toLowerCase() : undefined
  if (mine && mineActor && mineActor !== actor) {
    throw new JoinRefusal(`machine "${name}" is already on the roster and writes as "${mineActor}", not "${actor}". ` +
      'Pick another machine name, or join under the actor the roster already gives it.')
  }
  for (const [sname, cfg] of Object.entries(servers)) {
    if (sname === name || !cfg || typeof cfg !== 'object') continue
    const theirs = [cfg.access?.actor, ...asList(cfg.ledger_actors)].filter(Boolean).map((a: unknown) => String(a).toLowerCase())
    if (theirs.includes(actor)) {
      throw new JoinRefusal(`machine "${sname}" already writes as "${actor}". Two machines writing as one actor fork ` +
        'that writer\'s log; give the new machine its own actor (--actor <name>).')
    }
  }

  // The owner: named, else the principal whose decision is final, else the only human.
  let owner = opts.owner
  if (princDoc) {
    if (owner && !principals[owner]) throw new JoinRefusal(`principal "${owner}" is not in principals.yaml`)
    if (!owner) {
      const finals = Object.keys(principals).filter((p) => principals[p]?.decision === 'final')
      const humans = Object.keys(principals).filter((p) => principals[p]?.kind === 'human')
      owner = finals.length === 1 ? finals[0] : humans.length === 1 ? humans[0] : undefined
      if (!owner) throw new JoinRefusal('cannot tell whose machine this is: say which principal owns it (--owner <principal>)')
    }
    const registeredHere = mineActor === actor
    for (const [p, cfg] of Object.entries(principals)) {
      const writes = asList(cfg?.writes_as).map((a) => a.toLowerCase())
      if (!writes.includes(actor)) continue
      if (p === owner && registeredHere) continue
      throw new JoinRefusal(`principal "${p}" already writes as "${actor}". Two machines writing as one actor fork ` +
        'that writer\'s log; give the new machine its own actor (--actor <name>).')
    }
  }

  const result: RegisterResult = { owner, changed: [], notes: [] }
  if (!mine) {
    infraDoc.setIn(['servers', name], infraDoc.createNode({
      kind: 'workstation',
      ssh_alias: name,
      ledger_actors: [actor],
      notes: 'Joined with datacore join',
      access: { actor },
    }))
    result.changed.push(`infrastructure.yaml: servers.${name} (workstation, actor ${actor})`)
  }
  if (princDoc && owner) {
    for (const [field, value] of [['hosts', name], ['writes_as', actor]] as const) {
      const node = princDoc.getIn(['principals', owner, field], true)
      if (isSeq(node)) {
        if (!node.items.some((it: any) => String(it?.value ?? it).toLowerCase() === value)) {
          node.add(princDoc.createNode(value))
          result.changed.push(`principals.yaml: ${owner}.${field} + ${value}`)
        }
      } else if (node === undefined || node === null) {
        princDoc.setIn(['principals', owner, field], princDoc.createNode([value]))
        result.changed.push(`principals.yaml: ${owner}.${field} = [${value}]`)
      } else {
        const cur = princDoc.getIn(['principals', owner, field])
        if (String(cur).toLowerCase() !== value) {
          princDoc.setIn(['principals', owner, field], princDoc.createNode([String(cur), value]))
          result.changed.push(`principals.yaml: ${owner}.${field} + ${value}`)
        }
      }
    }
  } else if (!princDoc) {
    result.notes.push('no principals.yaml here: the owner\'s hosts and writers were not recorded')
  }

  if (mode.write !== false && result.changed.length) {
    const bk = backupDir()
    if (result.changed.some((c) => c.startsWith('infrastructure.yaml'))) {
      backup(infraPath, bk)
      writePrivate(infraPath, infraDoc.toString({ lineWidth: 0 }))
    }
    if (princDoc && result.changed.some((c) => c.startsWith('principals.yaml'))) {
      backup(princPath, bk)
      writePrivate(princPath, princDoc.toString({ lineWidth: 0 }))
    }
  }
  return result
}

/** Where this machine declares its actor (same lookup as actor_identity.py). */
export function identityFile(): string {
  return process.env.DATACORE_IDENTITY_FILE || join(homeDir(), '.datacore', 'identity.env')
}

export function readIdentityActor(file = identityFile()): string | undefined {
  if (!existsSync(file)) return undefined
  for (const raw of readFileSync(file, 'utf-8').split('\n')) {
    let line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    if (line.startsWith('export ')) line = line.slice(7).trim()
    const i = line.indexOf('=')
    if (line.slice(0, i).trim() !== 'DATACORE_ACTOR') continue
    let v = line.slice(i + 1).trim()
    if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1)
    return v.toLowerCase() || undefined
  }
  return undefined
}

/** Declare this machine's actor. Never replaces a different declaration. */
export function writeIdentity(actor: string, file = identityFile()): 'written' | 'present' {
  validateName(actor, 'actor')
  const have = readIdentityActor(file)
  if (have === actor) return 'present'
  if (have) {
    throw new JoinRefusal(`this machine already writes as "${have}" (${file}). Joining as "${actor}" would change who ` +
      'its events belong to; nothing was changed. If that declaration is wrong, edit the file yourself and run join again.')
  }
  const prev = existsSync(file) ? readFileSync(file, 'utf-8') : ''
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writePrivate(file, `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}DATACORE_ACTOR=${actor}\n`)
  return 'written'
}

// ---------------------------------------------------------------------------
// Landing the local files on the new machine.

export interface ApplyReport {
  written: string[]
  kept: string[]
  same: string[]
  merged: string[]
  refused: string[]
  notes: string[]
}

function bare(name: string): string {
  const s = String(name).replace(/\/+$/, '')
  const i = s.indexOf('-')
  return i > 0 && /^\d+$/.test(s.slice(0, i)) && s.slice(i + 1) ? s.slice(i + 1) : s
}

function onlyExistingSpaces(roles: Record<string, unknown>, spaces: Set<string>): { kept: Record<string, unknown>; dropped: string[] } {
  const kept: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [k, v] of Object.entries(roles)) {
    const vals = Array.isArray(v) ? v : [v]
    const ok = vals.map((x) => bare(String(x))).filter((x) => spaces.has(x))
    if (ok.length) kept[k] = Array.isArray(v) ? ok : ok[0]
    else dropped.push(`${k}=${String(v)}`)
  }
  return { kept, dropped }
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * WHOLE files land only where the machine has none; MERGE files gain only the
 * allowed top-level keys (and `roles` sub-keys) they lack -- the same rules as
 * local_files_sync.py. One difference, for a machine being set up: a MERGE
 * roster file it does not have at all is written whole (the script, pushing to
 * an established host, declines to create one).
 */
export function applyLocalFiles(root: string, files: Record<string, string>, rules: LocalFileRules): ApplyReport {
  const rep: ApplyReport = { written: [], kept: [], same: [], merged: [], refused: [], notes: [] }
  const spaces = new Set(spaceDirs(root).map(bare))
  let bk: string | null = null
  for (const [rel, content] of Object.entries(files)) {
    if (!safeRel(rel) || NEVER_CARRY.test(rel) || typeof content !== 'string') {
      rep.refused.push(`${rel}: not a path this command writes`)
      continue
    }
    const verdict = repoVerdict(root, rel)
    if (verdict !== 'ignored') {
      rep.refused.push(`${rel}: ${verdict} in its repository here -- it would be committed there, so it was not written`)
      continue
    }
    const abs = join(root, rel)
    if (!rules.merge.includes(rel)) {
      if (!existsSync(abs)) { writePrivate(abs, content); rep.written.push(rel) }
      else if (readFileSync(abs, 'utf-8') === content) rep.same.push(rel)
      else rep.kept.push(rel)
      continue
    }

    const allowed = rules.allowed[rel] ?? []
    let src: Record<string, unknown>
    try { src = (parse(content) ?? {}) as Record<string, unknown> } catch { rep.refused.push(`${rel}: the bundle's copy does not parse`); continue }
    const local: Record<string, unknown> = {}
    for (const k of allowed) if (k in src) local[k] = src[k]
    if (rel === rules.spaceRolesFile && isPlain(local.roles)) {
      const { kept, dropped } = onlyExistingSpaces(local.roles, spaces)
      local.roles = kept
      if (dropped.length) rep.notes.push(`${rel}: roles not added, this machine has no such space: ${dropped.join(', ')}`)
    }

    if (!existsSync(abs)) {
      if (rel === rules.spaceRolesFile) {
        if (isPlain(local.roles) && Object.keys(local.roles).length) { writePrivate(abs, stringify(local)); rep.written.push(rel) }
      } else {
        writePrivate(abs, content)
        rep.written.push(rel)
      }
      continue
    }
    const doc = parseDocument(readFileSync(abs, 'utf-8'))
    if (doc.errors.length) { rep.refused.push(`${rel}: this machine's copy does not parse; left as it is`); continue }
    if (!isMap(doc.contents) && doc.contents !== null) { rep.refused.push(`${rel}: not a mapping; left as it is`); continue }
    const added: string[] = []
    for (const [k, v] of Object.entries(local)) {
      if (!doc.has(k)) {
        if (isPlain(v) && !Object.keys(v).length) continue
        doc.set(k, doc.createNode(v))
        added.push(k)
      } else if (rules.nested.includes(k) && isPlain(v)) {
        const node = doc.get(k, true)
        if (!isMap(node)) continue
        for (const [sk, sv] of Object.entries(v)) {
          if (!node.has(sk)) { node.set(sk, doc.createNode(sv)); added.push(`${k}.${sk}`) }
        }
      }
    }
    if (!added.length) { rep.same.push(rel); continue }
    bk ??= backupDir()
    backup(abs, bk)
    writePrivate(abs, doc.toString({ lineWidth: 0 }))
    rep.merged.push(`${rel} (+${added.join(', ')})`)
  }
  return rep
}

// ---------------------------------------------------------------------------
// The credential store.

export interface RunResult { status: number; stdout: string; stderr: string }

export interface CredDeps {
  /** This machine's public ssh key (created when it has none). */
  publicKey?: () => string
  /** Run the credential broker: `creds <args>`. */
  creds?: (args: string[]) => RunResult
}

export interface CredResult {
  status: 'skipped' | 'waiting-for-owner' | 'done' | 'failed'
  detail: string
  ownerSteps: string[]
  doctor?: { ok: number; fail: number; na: number }
  /** Credential ids the broker's doctor reported FAIL (ids only, never values). */
  failing?: string[]
}

function storeHost(remote: string): string | null {
  const ssh = remote.match(/^ssh:\/\/([^/]+)\//)
  if (ssh) return ssh[1]!.replace(/:\d+$/, '')
  const scp = remote.match(/^([^/@:\s]+@)?([^/:\s]+):(?!\/\/)/)
  if (scp) return `${scp[1] ?? ''}${scp[2]}`
  return null
}

/** What the owner does on the store side: the only way a machine gets credentials. */
export function ownerStoreSteps(o: { name: string; sourceInstance?: string; publicKey?: string | null; remote?: string }): string[] {
  const src = o.sourceInstance || '<the existing machine\'s instance>'
  const host = o.remote ? storeHost(o.remote) : null
  const key = o.publicKey || '<the public key `datacore join` prints on the new machine>'
  return [
    `On the existing machine (the credential store decides who gets what; ${o.name} cannot grant itself access):`,
    `  1. Give ${o.name} the same credentials as ${src}:`,
    `       cd ~/Data/.datacore/secrets && git pull --ff-only`,
    `       sed 's/^name: .*/name: ${o.name}/' instances/${src}.yaml > instances/${o.name}.yaml`,
    `       git add instances/${o.name}.yaml && git commit -m "instance: ${o.name} (datacore join)" -- instances/${o.name}.yaml && git push`,
    `  2. Authorise ${o.name}'s ssh key on the store host${host ? ` (${host})` : ''}:`,
    `       ${host ? `ssh ${host}` : 'ssh <store-host>'} 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys' <<'EOF'`,
    `       ${key}`,
    `       EOF`,
  ]
}

export function ensurePublicKey(): string {
  const sshDir = join(homeDir(), '.ssh')
  for (const k of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    const pub = join(sshDir, `${k}.pub`)
    if (existsSync(pub)) return readFileSync(pub, 'utf-8').trim()
  }
  mkdirSync(sshDir, { recursive: true, mode: 0o700 })
  const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `datacore-join@${shortHostname()}`,
    '-f', join(sshDir, 'id_ed25519')], { encoding: 'utf-8' })
  if (r.status !== 0) throw new JoinRefusal(`this machine has no ssh key and ssh-keygen failed: ${(r.stderr ?? '').trim()}`)
  return readFileSync(join(sshDir, 'id_ed25519.pub'), 'utf-8').trim()
}

function defaultCreds(root: string): (args: string[]) => RunResult {
  const local = join(root, '.datacore', 'bin', 'creds')
  const bin = existsSync(local) ? local : 'creds'
  return (args) => {
    const r = spawnSync(bin, args, { encoding: 'utf-8', env: { ...process.env, DATACORE_ROOT: root }, timeout: 600000 })
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') }
  }
}

/**
 * Join the credential store with the access the source machine has. Read-only
 * towards the store: it clones and pulls, never commits or pushes. Until the
 * owner has granted access (manifest pushed, key authorised) it reports
 * 'waiting-for-owner' with the steps; running it again continues.
 */
export async function joinCredentialStore(
  root: string,
  o: { name: string; sourceInstance?: string; remote?: string },
  deps: CredDeps = {},
): Promise<CredResult> {
  if (!o.remote) {
    return { status: 'skipped', detail: 'the existing machine has no credential store (.datacore/secrets), so there is nothing to join', ownerSteps: [] }
  }
  const dir = join(root, '.datacore', 'secrets')
  const key = (deps.publicKey ?? ensurePublicKey)()
  const ownerSteps = ownerStoreSteps({ name: o.name, sourceInstance: o.sourceInstance, publicKey: key, remote: o.remote })
  const env = { ...process.env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15', GIT_TERMINAL_PROMPT: '0' }
  const waiting = (detail: string): CredResult => ({ status: 'waiting-for-owner', detail, ownerSteps })

  if (!existsSync(join(dir, '.git'))) {
    if (!git(root, ['ls-remote', '-q', o.remote], env).ok) return waiting('this machine cannot read the credential store yet')
    mkdirSync(dirname(dir), { recursive: true })
    const c = git(dirname(dir), ['clone', '-q', o.remote, dir], env)
    if (!c.ok) return waiting(`cloning the credential store failed: ${c.err.split('\n')[0]}`)
    try { chmodSync(dir, 0o700) } catch { /* not POSIX */ }
  } else {
    const p = git(dir, ['pull', '-q', '--ff-only'], env)
    if (!p.ok && !existsSync(join(dir, 'instances', `${o.name}.yaml`))) {
      return waiting(`could not update the credential store: ${p.err.split('\n')[0]}`)
    }
  }
  if (!existsSync(join(dir, 'instances', `${o.name}.yaml`))) {
    return waiting(`the credential store has no instances/${o.name}.yaml yet`)
  }

  const install = join(dir, 'scripts', 'install.sh')
  if (existsSync(install)) {
    // Its output is not shown: it is the store's own script, and nothing it
    // prints is needed here. A failure is reported by exit code only.
    const r = spawnSync('bash', [install, o.name], { cwd: dir, encoding: 'utf-8', env: { ...process.env, DATACORE_ROOT: root }, timeout: 600000 })
    if (r.status !== 0) return { status: 'failed', detail: `the store's scripts/install.sh ${o.name} failed (exit ${r.status})`, ownerSteps: [] }
  }
  const creds = deps.creds ?? defaultCreds(root)
  const sync = creds(['sync'])
  if (sync.status !== 0) return { status: 'failed', detail: `creds sync failed (exit ${sync.status})`, ownerSteps: [] }
  const doc = creds(['doctor'])
  const counts = { ok: 0, fail: 0, na: 0 }
  const failing: string[] = []
  for (const line of doc.stdout.split('\n')) {
    const [word, id] = line.trim().split(/\s+/)
    if (word === 'ok') counts.ok++
    else if (word === 'FAIL') { counts.fail++; if (id) failing.push(id) }
    else if (word === 'n-a') counts.na++
  }
  return {
    status: 'done',
    detail: `creds doctor: ${counts.ok} ok, ${counts.fail} FAIL, ${counts.na} could not tell (n-a)`,
    ownerSteps: [],
    doctor: counts,
    failing,
  }
}

// ---------------------------------------------------------------------------
// The bundle.

export interface JoinBundle {
  kind: 'datacore-join-bundle'
  version: 1
  created: string
  cliVersion: string
  machine: { name: string; actor: string; owner?: string }
  source: { actor?: string; hostname: string; credsInstance?: string; credsRemote?: string }
  snapshot: Snapshot
  /** Root-relative path -> content: the install-local files git does not carry. */
  files: Record<string, string>
}

export function readBundle(path: string): JoinBundle {
  if (!existsSync(path)) throw new JoinRefusal(`no such file: ${path}. Make one on the existing machine: datacore join --prepare <this-machine>`)
  let b: JoinBundle
  try { b = parse(readFileSync(path, 'utf-8')) as JoinBundle } catch (e) { throw new JoinRefusal(`${path} is not a join bundle: ${(e as Error).message}`) }
  if (!b || b.kind !== 'datacore-join-bundle' || b.version !== 1) {
    throw new JoinRefusal(`${path} is not a join bundle (made by: datacore join --prepare <this-machine>)`)
  }
  if (!b.machine?.name || !b.machine?.actor) throw new JoinRefusal(`${path}: the bundle names no machine or actor`)
  validateName(b.machine.name, 'machine name')
  validateName(b.machine.actor, 'actor')
  if (!b.snapshot || !Array.isArray(b.snapshot.spaces) || !Array.isArray(b.snapshot.modules)) throw new JoinRefusal(`${path}: the bundle has no snapshot`)
  b.files ??= {}
  for (const [rel, text] of Object.entries(b.files)) {
    if (!safeRel(rel) || NEVER_CARRY.test(rel) || typeof text !== 'string') throw new JoinRefusal(`${path}: refusing a bundle that writes ${rel}`)
  }
  return b
}

/** The source machine's own actor, resolved like actor_identity.py (env, identity.env, registry). */
export function sourceActor(root: string): string | undefined {
  const env = (process.env.DATACORE_ACTOR || '').trim().toLowerCase()
  if (env) return env
  const declared = readIdentityActor()
  if (declared) return declared
  try {
    const infra = parse(readFileSync(join(root, '.datacore', 'registry', 'infrastructure.yaml'), 'utf-8')) as { servers?: Record<string, any> }
    const host = shortHostname()
    for (const [name, cfg] of Object.entries(infra?.servers ?? {})) {
      const declaredHost = String(cfg?.access?.hostname ?? '').toLowerCase()
      if ((host === declaredHost || host === name.toLowerCase()) && cfg?.access?.actor) return String(cfg.access.actor).toLowerCase()
    }
  } catch { /* no roster, or one that does not parse */ }
  return undefined
}

function sourceCredStore(root: string): { instance?: string; remote?: string } {
  const dir = join(root, '.datacore', 'secrets')
  if (!existsSync(join(dir, '.git'))) return {}
  const instFile = join(dir, '.instance')
  const instance = existsSync(instFile) ? readFileSync(instFile, 'utf-8').trim() || undefined : undefined
  const r = git(dir, ['remote', 'get-url', 'origin'])
  // A URL with a password in it is a credential: carry the location, not the secret.
  const remote = r.ok && r.out ? r.out.replace(/(\/\/[^/@:\s]+):[^/@\s]+@/, '$1@') : undefined
  return { instance, remote }
}

export interface PrepareResult {
  path: string
  /** The one command to run on the new machine. */
  command: string
  copyHint: string
  machine: JoinBundle['machine']
  registered: string[]
  notes: string[]
  skipped: string[]
  files: string[]
  ownerSteps: string[]
  rulesFrom: string
}

/**
 * On the EXISTING machine: register the new one and write its bundle.
 * Every refusal (secret found, actor taken, registry broken) comes before
 * anything is changed.
 */
export function prepareJoin(opts: { root?: string; name: string; actor?: string; owner?: string; output?: string; dryRun?: boolean }): PrepareResult {
  const root = opts.root ?? dataDir()
  const name = opts.name
  const actor = opts.actor ?? name
  validateName(name, 'machine name')
  validateName(actor, 'actor')
  if (!existsSync(join(root, '.git'))) throw new JoinRefusal(`no Datacore installation at ${root}`)
  const self = sourceActor(root)
  if (self && self === actor) {
    throw new JoinRefusal(`"${actor}" is THIS machine's own actor. The new machine needs its own (--actor <name>), ` +
      'or the two would write one log.')
  }

  const rules = localFileRules(root)
  const snapshot = createSnapshot({ includeSettings: true, includeRegistry: true })
  const before = collectLocalFiles(root, rules)
  refuseOnSecrets(scanForSecrets({ ...before.files, 'snapshot (settings and registry)': stringify(snapshot, { lineWidth: 0 }) }))

  // Dry pass first: it raises every refusal without writing.
  const plan = registerMachine(root, { name, actor, owner: opts.owner }, { write: false })
  const reg = opts.dryRun ? plan : registerMachine(root, { name, actor, owner: opts.owner })

  // The registry now names the new machine; carry that version.
  const { files, skipped } = collectLocalFiles(root, rules)
  const registry: Record<string, string> = {}
  for (const f of PRIVATE_REGISTRY_FILES) {
    const p = join(root, '.datacore', 'registry', f)
    if (existsSync(p)) registry[f] = readFileSync(p, 'utf-8')
  }
  if (Object.keys(registry).length) snapshot.registry = registry
  const cred = sourceCredStore(root)
  const bundle: JoinBundle = {
    kind: 'datacore-join-bundle',
    version: 1,
    created: new Date().toISOString(),
    cliVersion: VERSION,
    machine: { name, actor, ...(reg.owner ? { owner: reg.owner } : {}) },
    source: { ...(self ? { actor: self } : {}), hostname: shortHostname(), ...(cred.instance ? { credsInstance: cred.instance } : {}), ...(cred.remote ? { credsRemote: cred.remote } : {}) },
    snapshot,
    files,
  }
  const text = stringify(bundle, { lineWidth: 0 })
  refuseOnSecrets(scanForSecrets({ ...files, bundle: text }))

  const path = opts.output ?? join(homeDir(), '.datacore', 'join', `${name}.join.yaml`)
  if (!opts.dryRun) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writePrivate(path, text)
  }
  return {
    path,
    command: `npx @datacore-one/cli join ~/${basename(path)}`,
    copyHint: `scp ${path} ${name}:`,
    machine: bundle.machine,
    registered: reg.changed,
    notes: reg.notes,
    skipped,
    files: Object.keys(files),
    ownerSteps: cred.remote ? ownerStoreSteps({ name, sourceInstance: cred.instance, publicKey: null, remote: cred.remote }) : [],
    rulesFrom: rules.from,
  }
}

// ---------------------------------------------------------------------------
// Checks, and the new-machine run.

export interface Check { name: string; ok: boolean; detail: string }
export type DoctorFn = () => { ok: boolean; message: string }

export function finalChecks(root: string, actor: string, doctor: DoctorFn): Check[] {
  const checks: Check[] = []
  const env = (process.env.DATACORE_ACTOR || '').trim().toLowerCase()
  const declared = readIdentityActor()
  const resolved = env || declared
  checks.push({
    name: 'identity',
    ok: resolved === actor,
    detail: resolved === actor
      ? `writes as ${actor} (${env ? 'DATACORE_ACTOR' : identityFile()})`
      : `resolves to ${resolved ?? 'nothing'}${env ? ' (DATACORE_ACTOR in this shell overrides identity.env)' : ''}, expected ${actor}`,
  })

  const repos = [{ name: 'root', path: root }, ...spaceDirs(root).map((s) => ({ name: s, path: join(root, s) }))]
    .filter((r) => existsSync(join(r.path, '.git')))
  const statuses = repos.map((r) => ({ ...r, s: getRepoStatus(r.path) }))
  const detached = statuses.filter((r) => !r.s || !r.s.branch || r.s.branch === 'unknown').map((r) => r.name)
  // Modules with a clone of their own: restore must leave them on a branch too.
  const modDir = join(root, '.datacore', 'modules')
  let modules = 0
  if (existsSync(modDir)) {
    for (const m of readdirSync(modDir).sort()) {
      const p = join(modDir, m)
      if (!existsSync(join(p, '.git'))) continue
      modules++
      if (isDetached(p)) detached.push(`module ${m}`)
    }
  }
  checks.push({
    name: 'branches',
    ok: detached.length === 0,
    detail: detached.length ? `not on a branch: ${detached.join(', ')}` : `${statuses.length + modules} repo(s), each on its branch`,
  })
  const dirtySpaces = statuses.filter((r) => r.name !== 'root' && r.s?.dirty).map((r) => r.name)
  const rootDirty = statuses.find((r) => r.name === 'root')?.s?.dirty
  checks.push({
    name: 'spaces clean',
    ok: dirtySpaces.length === 0,
    detail: (dirtySpaces.length ? `uncommitted changes in: ${dirtySpaces.join(', ')}` : `${statuses.length - 1} space(s) clean`) +
      (rootDirty ? '; root has uncommitted changes (datacore sync status)' : ''),
  })
  const d = doctor()
  checks.push({ name: 'doctor', ok: d.ok, detail: d.message || (d.ok ? 'green' : 'not green: run datacore doctor') })
  return checks
}

export interface JoinDeps extends CredDeps {
  initialized: () => boolean
  /** init --from-snapshot with this lock file. */
  init: (lockPath: string) => Promise<{ ok: boolean; errors: string[]; warnings: string[] }>
  doctor: DoctorFn
  /** Rebuild composed CLAUDE.md files after the local layers arrive. */
  contextRebuild?: (root: string) => boolean
  /** Called while the owner has store-side steps to do; resolve true to check again. */
  waitForOwner?: (r: CredResult) => Promise<boolean>
}

export interface JoinResult {
  ok: boolean
  machine: JoinBundle['machine']
  done: string[]
  warnings: string[]
  errors: string[]
  files?: ApplyReport
  credentials: CredResult
  checks: Check[]
  /** What the owner still has to do. Empty when nothing is left. */
  ownerTodo: string[]
}

function defaultContextRebuild(root: string): boolean {
  const script = join(root, '.datacore', 'lib', 'context_merge.py')
  if (!existsSync(script)) return false
  const r = spawnSync('python3', [script, 'rebuild', '--path', root], { cwd: root, encoding: 'utf-8', timeout: 300000 })
  return r.status === 0
}

/** On the NEW machine: everything from the bundle, in order. */
export async function runJoin(bundlePath: string, deps: JoinDeps): Promise<JoinResult> {
  const bundle = readBundle(bundlePath)
  const root = dataDir()
  const { name, actor } = bundle.machine
  const res: JoinResult = { ok: false, machine: bundle.machine, done: [], warnings: [], errors: [], credentials: { status: 'skipped', detail: '', ownerSteps: [] }, checks: [], ownerTodo: [] }

  // Preflight: every refusal before the first change.
  try {
    if ((statSync(bundlePath).mode & 0o077) !== 0) res.warnings.push(`${bundlePath} is readable by other users; it holds private registry data (chmod 600 it, or delete it after joining)`)
  } catch { /* not POSIX */ }
  const have = readIdentityActor()
  if (have && have !== actor) {
    throw new JoinRefusal(`this machine already writes as "${have}" (${identityFile()}); the bundle joins it as "${actor}". ` +
      'Nothing was changed. If the declaration here is wrong, edit that file yourself; otherwise prepare the bundle with --actor ' + have + '.')
  }
  const env = (process.env.DATACORE_ACTOR || '').trim().toLowerCase()
  if (env && env !== actor) res.warnings.push(`DATACORE_ACTOR=${env} is set in this shell and overrides identity.env; unset it for sessions here`)
  // A roster that does not parse is refused, not edited: the bundle's copy
  // (it would be written here as is) and any this machine already has.
  for (const f of ['infrastructure.yaml', 'principals.yaml']) {
    const text = bundle.snapshot.registry?.[f]
    if (typeof text === 'string') {
      const e = parseDocument(text).errors[0]
      if (e) {
        const line = e.linePos?.[0]?.line
        throw new JoinRefusal(`the bundle's ${f} does not parse${line ? ` (line ${line})` : ''}: ${e.code}. Nothing was changed. ` +
          'Fix it on the existing machine, then run datacore join --prepare again.')
      }
    }
    loadDoc(join(root, '.datacore', 'registry', f), `this machine's ${f}`)
  }
  const bundleInfra = bundle.snapshot.registry?.['infrastructure.yaml']
  if (bundleInfra) {
    const servers = ((parseDocument(bundleInfra).toJS() ?? {}) as { servers?: Record<string, any> }).servers ?? {}
    for (const [sname, cfg] of Object.entries(servers)) {
      if (sname === name) continue
      const theirs = [cfg?.access?.actor, ...asList(cfg?.ledger_actors)].filter(Boolean).map((a: unknown) => String(a).toLowerCase())
      if (theirs.includes(actor)) throw new JoinRefusal(`machine "${sname}" already writes as "${actor}" in the bundle's roster; nothing was changed`)
    }
  }
  if (shortHostname() !== actor) res.warnings.push(`this machine's hostname is ${shortHostname()}; it joins as ${actor}, as the bundle says`)

  // 1. init --from-snapshot, or restore onto an installation that exists.
  if (!deps.initialized()) {
    const lockDir = join(tmpdir(), `datacore-join-${process.pid}-${Date.now()}`)
    mkdirSync(lockDir, { recursive: true, mode: 0o700 })
    const lockPath = join(lockDir, 'datacore.lock.yaml')
    writePrivate(lockPath, stringify(bundle.snapshot, { lineWidth: 0 }))
    let r: Awaited<ReturnType<JoinDeps['init']>>
    try { r = await deps.init(lockPath) } finally { rmSync(lockDir, { recursive: true, force: true }) }
    res.warnings.push(...r.warnings)
    if (!r.ok) {
      res.errors.push(...r.errors)
      res.errors.push('init from the bundle failed; nothing else was done. Fix the above and run the same join command again.')
      return res
    }
    res.done.push(`set up from the snapshot: root, ${bundle.snapshot.spaces.length} space(s), ${bundle.snapshot.modules.length} module(s)`)
  } else {
    const r = restoreFromSnapshot(bundle.snapshot)
    res.warnings.push(...r.warnings)
    for (const f of r.modulesFailed) res.warnings.push(`module ${f.name}: ${f.error}`)
    res.done.push(`installation already here: added ${r.spacesCreated.length} space(s), ${r.modulesInstalled.length} module(s), ` +
      `${r.registryWritten.length} registry file(s)`)
  }
  for (const s of ['', ...spaceDirs(root)]) {
    const p = s ? join(root, s) : root
    if (!existsSync(join(p, '.git')) || !isDetached(p)) continue
    const back = reattach(p)
    if (back.ok && back.switched) res.done.push(`${s || 'root'}: moved from a detached HEAD onto ${back.branch}`)
    else if (!back.ok) res.warnings.push(`${s || 'root'}: ${back.error}`)
  }

  // 2. Install-local files.
  const rules = localFileRules(root)
  res.files = applyLocalFiles(root, bundle.files, rules)
  res.done.push(`local files (rules from ${rules.from}): ${res.files.written.length} written, ${res.files.merged.length} merged, ` +
    `${res.files.kept.length} kept as this machine had them, ${res.files.same.length} already the same`)
  for (const r of res.files.refused) res.warnings.push(r)
  res.warnings.push(...res.files.notes)

  // 3. Registration and identity.
  const reg = registerMachine(root, { name, actor, owner: bundle.machine.owner })
  res.done.push(reg.changed.length ? `registered here: ${reg.changed.join('; ')}` : `already on this machine's roster as ${name} (actor ${actor})`)
  res.warnings.push(...reg.notes)
  const id = writeIdentity(actor)
  res.done.push(`${identityFile()}: DATACORE_ACTOR=${actor}${id === 'present' ? ' (already declared)' : ''}`)
  if ((deps.contextRebuild ?? defaultContextRebuild)(root)) res.done.push('context files rebuilt with the private layers')

  // 4. Credential store: the owner grants, this machine waits.
  const credOpts = { name, sourceInstance: bundle.source?.credsInstance, remote: bundle.source?.credsRemote }
  let cred = await joinCredentialStore(root, credOpts, deps)
  for (let i = 0; cred.status === 'waiting-for-owner' && deps.waitForOwner && i < 50; i++) {
    if (!(await deps.waitForOwner(cred))) break
    cred = await joinCredentialStore(root, credOpts, deps)
  }
  res.credentials = cred
  if (cred.status === 'done') res.done.push(`credential store joined as instance ${name}; ${cred.detail}`)
  else if (cred.status === 'skipped') res.warnings.push(`credentials: ${cred.detail}`)
  else res.errors.push(`credentials: ${cred.detail}`)

  // 5. Checks.
  res.checks = finalChecks(root, actor, deps.doctor)
  if (cred.status === 'waiting-for-owner') {
    res.ownerTodo.push(...cred.ownerSteps, `  Then run the same join command again on ${name}; it continues where it stopped.`)
  }
  if (cred.status === 'done' && cred.doctor && (cred.doctor.fail || cred.doctor.na)) {
    res.ownerTodo.push(`Credentials: ${cred.doctor.fail} FAIL, ${cred.doctor.na} could not tell (n-a)` +
      `${cred.failing?.length ? `: ${cred.failing.join(', ')}` : ''}. Before rotating anything, compare across hosts: creds compare <id>`)
  }
  for (const c of res.checks) if (!c.ok) res.ownerTodo.push(`${c.name}: ${c.detail}`)
  res.ok = res.errors.length === 0 && res.checks.every((c) => c.ok) && (cred.status === 'done' || cred.status === 'skipped')
  return res
}
