/**
 * Space management utilities.
 *
 * Spaces are numbered directories in ~/Data following the pattern [N]-[name]/
 */

import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, basename } from 'path'
import { execFileSync, which } from './exec'
import type { SpaceInfo } from '../types'
import { dataDir } from './paths'

const DATA_DIR = () => dataDir()

/**
 * List all spaces in the Datacore installation.
 */
export function listSpaces(): SpaceInfo[] {
  if (!existsSync(DATA_DIR())) {
    return []
  }

  const entries = readdirSync(DATA_DIR(), { withFileTypes: true })
  const spaces: SpaceInfo[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    // Match pattern: [N]-[name]
    const match = entry.name.match(/^(\d+)-(.+)$/)
    if (!match) continue

    const [, numStr, name] = match
    const number = parseInt(numStr!, 10)
    const path = join(DATA_DIR(), entry.name)

    spaces.push({
      name: entry.name,
      number,
      path,
      type: number === 0 ? 'personal' : 'team',
      hasGit: existsSync(join(path, '.git')),
      hasClaude: existsSync(join(path, 'CLAUDE.md')) || existsSync(join(path, 'CLAUDE.base.md')),
    })
  }

  // Sort by number
  spaces.sort((a, b) => a.number - b.number)

  return spaces
}

/**
 * Get info about a specific space by name or number.
 */
export function getSpace(nameOrNumber: string | number): SpaceInfo | null {
  const spaces = listSpaces()

  if (typeof nameOrNumber === 'number') {
    return spaces.find((s) => s.number === nameOrNumber) || null
  }

  // Try exact match first
  let space = spaces.find((s) => s.name === nameOrNumber)
  if (space) return space

  // Try partial match (e.g., "personal" matches "0-personal")
  space = spaces.find((s) => s.name.includes(nameOrNumber))
  return space || null
}

/**
 * Get the next available space number.
 */
export function getNextSpaceNumber(): number {
  const spaces = listSpaces()
  // 0 is RESERVED for the personal space. Returning it for the first team space
  // — which is what happened on an install whose personal space did not yet
  // exist — produces `0-<team>` colliding with `0-personal`, and breaks every
  // convention that reads the 0 prefix as "this is the personal space".
  if (spaces.length === 0) return 1
  return Math.max(1, Math.max(...spaces.map((s) => s.number)) + 1)
}

/**
 * Create a new space with the standard folder structure.
 */
/**
 * A new space's .gitignore. Every composed context file is listed: CLAUDE.md
 * and its harness twins AGENTS.md (Codex, Cursor, Antigravity, OpenCode,
 * OpenClaw) and GEMINI.md carry the private layer, and context_merge only
 * writes a twin where git ignores it.
 */
export function spaceGitignore(type: 'personal' | 'team'): string {
  const lines = ['.datacore/state/', '.datacore/env/', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'CLAUDE.local.md']
  if (type === 'team') lines.push('2-projects/')
  return lines.join('\n') + '\n'
}

export function createSpace(name: string, type: 'personal' | 'team' = 'team'): SpaceInfo {
  // Determine number
  const number = type === 'personal' ? 0 : getNextSpaceNumber()

  // Normalize name (lowercase, hyphenated)
  const normalizedName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const folderName = `${number}-${normalizedName}`
  const spacePath = join(DATA_DIR(), folderName)

  if (existsSync(spacePath)) {
    throw new Error(`Space already exists: ${folderName}`)
  }

  // Create main directory
  mkdirSync(spacePath, { recursive: true })

  // Personal spaces have GTD-focused structure per DIP-0009
  // Team spaces have the full organizational structure per DIP-0003
  const dirs = type === 'personal' ? [
    '.datacore',
    '.datacore/commands',
    '.datacore/agents',
    '.datacore/learning',
    '.datacore/state',
    '.datacore/env',
    'org',                    // GTD org files (inbox, next_actions, nightshift, habits)
    '0-inbox',                // File inbox (unprocessed files)
    '1-active',               // Live efforts — the personal analogue of 1-tracks
    '2-projects',             // Project working copies (gitignored)
    'notes',                  // Personal knowledge base (Obsidian)
    'notes/journals',         // Daily personal journals
    'notes/pages',            // Wiki pages
    'notes/zettel',           // Atomic notes
    'journal',                // AI session journals (auto-generated)
    '3-knowledge',            // Structured knowledge
    '3-knowledge/pages',      // General wiki pages
    '3-knowledge/zettel',     // Atomic concept notes
    '3-knowledge/literature', // Source summaries
    '3-knowledge/reference',  // People, companies, glossary
    '4-archive',              // Historical/completed content
    'content',                // Generated content (blog, emails, etc.)
  ] : [
    '.datacore',
    '.datacore/commands',
    '.datacore/agents',
    '.datacore/learning',
    '.datacore/state',
    '.datacore/env',
    'org',
    '0-inbox',
    'journal',
    '1-tracks',
    '1-tracks/ops',
    '1-tracks/product',
    '1-tracks/dev',
    '1-tracks/research',
    '1-tracks/comms',
    '2-projects',
    '3-knowledge',
    '3-knowledge/pages',
    '3-knowledge/zettel',
    '3-knowledge/literature',
    '3-knowledge/reference',
    '4-archive',
  ]

  for (const dir of dirs) {
    mkdirSync(join(spacePath, dir), { recursive: true })
  }

  // Create GTD org files per DIP-0009
  if (type === 'personal') {
    // inbox.org - Single capture point (sacred, always process to zero)
    writeFileSync(
      join(spacePath, 'org', 'inbox.org'),
      `#+TITLE: Inbox
#+FILETAGS: :inbox:

Capture everything here. Process daily to zero.

* TODO Do more. With less.
* Inbox
`
    )

    // next_actions.org - Active tasks by focus area/context
    writeFileSync(
      join(spacePath, 'org', 'next_actions.org'),
      `#+TITLE: Next Actions
#+TODO: TODO NEXT WAITING | DONE CANCELED
#+FILETAGS: :tasks:

Tasks organized by focus area. Tag with :AI: to delegate to agents.

* TIER 1: STRATEGIC FOUNDATION
** /Projects
** /Work
* TIER 2: SUPPORTING WORK
** Admin
** Maintenance
* PERSONAL: LIFE & DEVELOPMENT
** /Personal Development
** /Health & Longevity
** Home & Family
** Financial Management
* RESEARCH & LEARNING
** Technology
** Skills
`
    )

    // nightshift.org - AI task queue (per DIP-0009 and DIP-0011)
    writeFileSync(
      join(spacePath, 'org', 'nightshift.org'),
      `#+TITLE: Nightshift Queue
#+TODO: QUEUED EXECUTING | DONE FAILED
#+FILETAGS: :nightshift:

AI tasks queued for overnight execution. Managed by /tomorrow command.

* Queue
`
    )

    // habits.org - Recurring behaviors
    writeFileSync(
      join(spacePath, 'org', 'habits.org'),
      `#+TITLE: Habits
#+FILETAGS: :habits:

Recurring behaviors and routines. Track with org-habit.

* Daily
* Weekly
* Monthly
`
    )

    // someday.org - Future possibilities
    writeFileSync(
      join(spacePath, 'org', 'someday.org'),
      `#+TITLE: Someday/Maybe
#+FILETAGS: :someday:

Ideas and projects for the future. Review monthly.

* Someday
* Maybe
`
    )

    // archive.org - Completed/canceled tasks
    writeFileSync(
      join(spacePath, 'org', 'archive.org'),
      `#+TITLE: Archive
#+FILETAGS: :archive:

Completed and canceled tasks. Searchable history.

* Archived Tasks
`
    )
  } else {
    writeFileSync(
      join(spacePath, 'org', 'inbox.org'),
      `#+TITLE: Inbox
#+FILETAGS: :inbox:

* Capture items here
`
    )

    writeFileSync(
      join(spacePath, 'org', 'next_actions.org'),
      `#+TITLE: Next Actions
#+FILETAGS: :tasks:

* Tasks
** TODO items go here
`
    )
  }

  // Create index file
  if (type === 'personal') {
    writeFileSync(
      join(spacePath, '_index.md'),
      `# Personal Space

Your personal knowledge base and GTD system.

## GTD Workflow

1. **Capture** → \`org/inbox.org\` - dump everything here
2. **Clarify** → Is it actionable? What's the next action?
3. **Organize** → Move to \`next_actions.org\` by focus area
4. **Reflect** → Weekly review, monthly strategic
5. **Engage** → Do the work, delegate with :AI: tags

## Org Files (GTD)

| File | Purpose |
|------|---------|
| [inbox.org](org/inbox.org) | Single capture point - process to zero daily |
| [next_actions.org](org/next_actions.org) | Active tasks by focus area |
| [nightshift.org](org/nightshift.org) | AI task queue (overnight processing) |
| [habits.org](org/habits.org) | Recurring behaviors |
| [someday.org](org/someday.org) | Future possibilities |
| [archive.org](org/archive.org) | Completed/canceled tasks |

## Knowledge

| Folder | Purpose |
|--------|---------|
| [notes/](notes/) | Personal knowledge base (Obsidian) |
| [notes/journals/](notes/journals/) | Daily personal journals |
| [3-knowledge/](3-knowledge/) | Structured knowledge (zettelkasten) |

## Other

- [journal/](journal/) - AI session journals (auto-generated)
- [content/](content/) - Generated content (drafts, emails)
- [0-inbox/](0-inbox/) - File inbox (process files here)
- [4-archive/](4-archive/) - Historical content
`
    )
  } else {
    writeFileSync(
      join(spacePath, '_index.md'),
      `# ${name}

Team space.

## Structure

- \`org/\` - Task coordination
- \`1-tracks/\` - Department work
- \`2-projects/\` - Code repositories
- \`3-knowledge/\` - Shared knowledge
- \`4-archive/\` - Historical content

## Quick Links

- [Inbox](org/inbox.org)
- [Tasks](org/next_actions.org)
- [Journal](journal/)
- [Knowledge](3-knowledge/)
`
    )
  }

  // Create CLAUDE context
  if (type === 'personal') {
    writeFileSync(
      join(spacePath, 'CLAUDE.base.md'),
      `# Personal Space

Personal GTD system and knowledge base (per DIP-0009).

## GTD Files

| File | Purpose | Process |
|------|---------|---------|
| \`org/inbox.org\` | Single capture point | Process to zero daily |
| \`org/next_actions.org\` | Active tasks by focus area | Work from here |
| \`org/nightshift.org\` | AI task queue | Auto-managed by /tomorrow |
| \`org/habits.org\` | Recurring behaviors | Track daily |
| \`org/someday.org\` | Future possibilities | Review monthly |
| \`org/archive.org\` | Completed tasks | Searchable history |

## Task States

| State | Meaning |
|-------|---------|
| \`TODO\` | Standard next action |
| \`NEXT\` | High priority, work today |
| \`WAITING\` | Blocked on external |
| \`DONE\` | Completed (terminal) |
| \`CANCELED\` | Will not do (terminal) |

## AI Delegation

Tag tasks with \`:AI:\` to delegate to agents:

| Tag | Agent | Autonomous |
|-----|-------|------------|
| \`:AI:content:\` | gtd-content-writer | Yes |
| \`:AI:research:\` | gtd-research-processor | Yes |
| \`:AI:data:\` | gtd-data-analyzer | Yes |
| \`:AI:pm:\` | gtd-project-manager | Yes |

## Knowledge Structure

| Location | Purpose |
|----------|---------|
| \`notes/\` | Personal knowledge base (Obsidian) |
| \`notes/journals/\` | Daily personal reflections |
| \`3-knowledge/zettel/\` | Atomic concept notes |
| \`3-knowledge/literature/\` | Source summaries |

## Daily Workflow

1. **Morning** - Run \`/today\` for briefing
2. **Capture** - Everything to inbox.org
3. **Process** - Clear inbox, route tasks
4. **Work** - Focus on NEXT items
5. **Evening** - Run \`/tomorrow\` for wrap-up

## See Also

Parent: ~/Data/CLAUDE.md
`
    )
  } else {
    writeFileSync(
      join(spacePath, 'CLAUDE.base.md'),
      `# ${name} Space

Team space for ${name}.

## Structure

See parent CLAUDE.md for full documentation.
`
    )
  }

  // Create .datacore/config.yaml
  writeFileSync(
    join(spacePath, '.datacore', 'config.yaml'),
    `# Space configuration
name: ${normalizedName}
type: ${type}
`
  )

  // Create learning files
  writeFileSync(join(spacePath, '.datacore', 'learning', 'patterns.md'), `# Patterns\n\nSuccessful approaches to remember.\n`)
  writeFileSync(join(spacePath, '.datacore', 'learning', 'corrections.md'), `# Corrections\n\nHuman feedback log.\n`)
  writeFileSync(join(spacePath, '.datacore', 'learning', 'preferences.md'), `# Preferences\n\nStyle and preference notes.\n`)

  // Create .gitignore
  writeFileSync(join(spacePath, '.gitignore'), spaceGitignore(type))

  return {
    name: folderName,
    number,
    path: spacePath,
    type,
    hasGit: false,
    hasClaude: true,
  }
}

/**
 * Audit a space for missing structure.
 */
export interface SpaceAuditResult {
  space: string
  path: string
  issues: SpaceAuditIssue[]
  status: 'healthy' | 'warnings' | 'errors'
}

export interface SpaceAuditIssue {
  type: 'missing' | 'warning' | 'error'
  path: string
  message: string
}

export function auditSpace(nameOrPath: string): SpaceAuditResult {
  // Resolve space
  let spacePath: string
  let spaceName: string

  if (existsSync(nameOrPath) && statSync(nameOrPath).isDirectory()) {
    spacePath = nameOrPath
    spaceName = basename(nameOrPath)
  } else {
    const space = getSpace(nameOrPath)
    if (!space) {
      throw new Error(`Space not found: ${nameOrPath}`)
    }
    spacePath = space.path
    spaceName = space.name
  }

  const issues: SpaceAuditIssue[] = []

  // Required directories
  const requiredDirs = [
    '.datacore',
    'org',
    '0-inbox',
    'journal',
  ]

  for (const dir of requiredDirs) {
    if (!existsSync(join(spacePath, dir))) {
      issues.push({
        type: 'missing',
        path: dir,
        message: `Required directory missing: ${dir}`,
      })
    }
  }

  // Required files
  const requiredFiles = [
    'org/inbox.org',
    'org/next_actions.org',
  ]

  for (const file of requiredFiles) {
    if (!existsSync(join(spacePath, file))) {
      issues.push({
        type: 'missing',
        path: file,
        message: `Required file missing: ${file}`,
      })
    }
  }

  // Recommended structure
  const recommendedDirs = [
    '1-tracks',
    '2-projects',
    '3-knowledge',
    '4-archive',
    '.datacore/learning',
  ]

  for (const dir of recommendedDirs) {
    if (!existsSync(join(spacePath, dir))) {
      issues.push({
        type: 'warning',
        path: dir,
        message: `Recommended directory missing: ${dir}`,
      })
    }
  }

  // CLAUDE context files
  if (!existsSync(join(spacePath, 'CLAUDE.base.md')) && !existsSync(join(spacePath, 'CLAUDE.md'))) {
    issues.push({
      type: 'warning',
      path: 'CLAUDE.base.md',
      message: 'No CLAUDE context file found',
    })
  }

  // Determine status
  let status: SpaceAuditResult['status'] = 'healthy'
  if (issues.some((i) => i.type === 'error' || i.type === 'missing')) {
    status = 'errors'
  } else if (issues.some((i) => i.type === 'warning')) {
    status = 'warnings'
  }

  return {
    space: spaceName,
    path: spacePath,
    issues,
    status,
  }
}


// ─── Git: a space is a repo ──────────────────────────────────────────────────

/**
 * Run a binary without a shell.
 *
 * `sync.ts` has a `runGit` that builds a shell string. That is fine for its
 * fixed arguments and wrong here, where the inputs are a repo URL and a space
 * name the user typed.
 */
function run(bin: string, args: string[], opts: { cwd?: string; timeout?: number } = {}):
  { ok: boolean; out: string; err: string } {
  try {
    const out = execFileSync(bin, args, {
      cwd: opts.cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: opts.timeout ?? 60_000,
    })
    return { ok: true, out: (out || '').trim(), err: '' }
  } catch (e) {
    const x = e as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string }
    const err = (x.stderr?.toString() || x.message || '').trim()
    return { ok: false, out: (x.stdout?.toString() || '').trim(), err }
  }
}

function binExists(bin: string): boolean {
  return which(bin) !== null
}

export type ForgeId = 'github' | 'gitlab'

export interface Forge {
  id: ForgeId
  label: string
  bin: string
  /** Usable right now: binary present AND authenticated. */
  available: boolean
  /** Who we are, when we could find out. */
  account?: string
  /** Why it is unusable, and what to run to fix it. */
  reason?: string
}

/**
 * Which forges can actually create a repo on this machine.
 *
 * Authentication is checked, not assumed. A menu entry whose binary exists but
 * whose token expired is worse than no entry: the user picks it, the space is
 * created locally, and the push fails at the end of a long install with a 401.
 * That is the same shape as the git-lfs and private-module failures this
 * installer was overhauled to remove, so it is reported up front instead --
 * shown, greyed, with the command that fixes it.
 */
export function detectForges(): Forge[] {
  const forges: Forge[] = []

  if (binExists('gh')) {
    const r = run('gh', ['auth', 'status'], { timeout: 15_000 })
    const account = (r.out + r.err).match(/Logged in to \S+ account (\S+)/i)?.[1]
    forges.push(r.ok && account
      ? { id: 'github', label: 'GitHub', bin: 'gh', available: true, account }
      : { id: 'github', label: 'GitHub', bin: 'gh', available: false, reason: 'not signed in — run: gh auth login' })
  } else {
    forges.push({ id: 'github', label: 'GitHub', bin: 'gh', available: false, reason: 'gh not installed' })
  }

  if (binExists('glab')) {
    // glab reports every configured host, self-hosted included, and exits
    // non-zero if ANY of them fails to authenticate. So read the per-host
    // lines rather than the exit code: one working host is enough.
    const r = run('glab', ['auth', 'status'], { timeout: 15_000 })
    const text = r.out + '\n' + r.err
    const hosts = text.split('\n')
      .map(l => l.match(/^\s*[✓x!]\s*(\S+?):/)?.[1])
      .filter((h): h is string => !!h)
    const broken = new Set(text.split('\n')
      .map(l => l.match(/^\s*x\s*(\S+?):/)?.[1])
      .filter((h): h is string => !!h))
    const ok = hosts.filter(h => !broken.has(h))
    forges.push(ok.length > 0
      ? { id: 'gitlab', label: 'GitLab', bin: 'glab', available: true, account: ok[0] }
      : { id: 'gitlab', label: 'GitLab', bin: 'glab', available: false, reason: 'no authenticated host — run: glab auth login' })
  } else {
    forges.push({ id: 'gitlab', label: 'GitLab', bin: 'glab', available: false, reason: 'glab not installed' })
  }

  return forges
}

/**
 * Make a space a git repository with one commit.
 *
 * `createSpace` wrote a `.gitignore` and returned `hasGit: false`, and nothing
 * ever ran `git init` -- so a created space was not a repo, in a system whose
 * own documentation says every space is one. Everything downstream (sync, push,
 * the ledger transport, joining from a second machine) assumes otherwise.
 */
export function initSpaceGit(spacePath: string): { ok: boolean; error?: string } {
  if (existsSync(join(spacePath, '.git'))) return { ok: true }

  const init = run('git', ['init', '-b', 'main'], { cwd: spacePath })
  if (!init.ok) return { ok: false, error: init.err || 'git init failed' }

  const add = run('git', ['add', '-A'], { cwd: spacePath })
  if (!add.ok) return { ok: false, error: add.err || 'git add failed' }

  // Commit with whatever identity git already has. If there is none, say so
  // and name the fix rather than inventing one: a commit authored by a made-up
  // address is worse than no commit, because it is permanent.
  const commit = run('git', ['commit', '-m', `Create ${basename(spacePath)} space`], { cwd: spacePath })
  if (!commit.ok) {
    const needsIdentity = /Please tell me who you are|user\.email|empty ident/i.test(commit.err)
    return {
      ok: false,
      error: needsIdentity
        ? 'git has no commit identity — run: git config --global user.email "you@example.com"'
        : (commit.err || 'git commit failed'),
    }
  }
  return { ok: true }
}

export interface RemoteResult {
  ok: boolean
  url?: string
  pushed: boolean
  error?: string
}

/**
 * Give a space a remote and push it.
 *
 * `forge` drives gh or glab directly. `url` takes an already-created empty repo
 * on any host -- Gitea, Codeberg, Bitbucket, self-hosted -- which is the escape
 * hatch that keeps this from being a GitHub-only feature.
 */
export function createSpaceRemote(
  spacePath: string,
  repoName: string,
  opts: { forge?: ForgeId; url?: string; visibility?: 'private' | 'public'; description?: string } = {},
): RemoteResult {
  const visibility = opts.visibility ?? 'private'

  if (!existsSync(join(spacePath, '.git'))) {
    const init = initSpaceGit(spacePath)
    if (!init.ok) return { ok: false, pushed: false, error: init.error }
  }

  if (opts.url) {
    const existing = run('git', ['remote', 'get-url', 'origin'], { cwd: spacePath })
    const set = existing.ok
      ? run('git', ['remote', 'set-url', 'origin', opts.url], { cwd: spacePath })
      : run('git', ['remote', 'add', 'origin', opts.url], { cwd: spacePath })
    if (!set.ok) return { ok: false, pushed: false, error: set.err || 'could not set origin' }

    const push = run('git', ['push', '-u', 'origin', 'main'], { cwd: spacePath, timeout: 300_000 })
    return push.ok
      ? { ok: true, url: opts.url, pushed: true }
      : { ok: true, url: opts.url, pushed: false, error: push.err || 'push failed — remote set, push it yourself' }
  }

  if (opts.forge === 'github') {
    const args = ['repo', 'create', repoName, `--${visibility}`, '--source=.', '--remote=origin', '--push']
    if (opts.description) args.push('--description', opts.description)
    const r = run('gh', args, { cwd: spacePath, timeout: 300_000 })
    if (!r.ok) return { ok: false, pushed: false, error: r.err || 'gh repo create failed' }
    const url = (r.out + r.err).match(/https?:\/\/\S+/)?.[0]
    return { ok: true, url, pushed: true }
  }

  if (opts.forge === 'gitlab') {
    // glab has no --source/--push pair. It creates the project, adds the
    // remote to the repo we are standing in, and leaves the push to us.
    const args = ['repo', 'create', repoName, visibility === 'private' ? '--private' : '--public']
    if (opts.description) args.push('--description', opts.description)
    const r = run('glab', args, { cwd: spacePath, timeout: 300_000 })
    if (!r.ok) return { ok: false, pushed: false, error: r.err || 'glab repo create failed' }
    const url = (r.out + r.err).match(/https?:\/\/\S+/)?.[0]
    const push = run('git', ['push', '-u', 'origin', 'main'], { cwd: spacePath, timeout: 300_000 })
    return push.ok
      ? { ok: true, url, pushed: true }
      : { ok: true, url, pushed: false, error: push.err || 'project created — push it yourself' }
  }

  return { ok: false, pushed: false, error: 'no forge or url given' }
}

// ─── Joining a space someone else already has ────────────────────────────────

export interface JoinResult {
  space: SpaceInfo
  /** Empty when the clone looks like a Datacore space. */
  warnings: string[]
}

/**
 * Clone an existing space repo in as the next numbered space.
 *
 * The second machine, and the second person on a team, both need this. Until
 * now it existed only inside `datacore init`, reachable only if you answered
 * "team" to an earlier question, and nowhere as a command -- so anyone past
 * first run had to clone by hand and get the numbering right themselves.
 */
export function joinSpace(url: string, opts: { name?: string; type?: 'personal' | 'team' } = {}): JoinResult {
  const derived = basename(url.replace(/\.git$/, '').replace(/\/+$/, ''))
  const raw = opts.name || derived
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (!normalized) throw new Error(`Could not derive a space name from: ${url}`)

  const already = listSpaces().find(s => s.name.replace(/^\d+-/, '') === normalized)
  if (already) throw new Error(`Space already present: ${already.name} (${already.path})`)

  const number = opts.type === 'personal' ? 0 : getNextSpaceNumber()
  const folderName = `${number}-${normalized}`
  const spacePath = join(DATA_DIR(), folderName)
  if (existsSync(spacePath)) throw new Error(`Directory already exists: ${folderName}`)

  let r = run('git', ['clone', url, spacePath], { timeout: 600_000 })
  if (!r.ok && /^https:\/\/github\.com\//.test(url)) {
    // A private space over HTTPS without a credential helper fails where SSH
    // succeeds. init.ts already learned this for its own clone path.
    const ssh = url.replace(/^https:\/\/github\.com\//, 'git@github.com:')
    r = run('git', ['clone', ssh, spacePath], { timeout: 600_000 })
  }
  if (!r.ok) {
    if (existsSync(spacePath)) rmSync(spacePath, { recursive: true, force: true })
    throw new Error(`Could not clone ${url}: ${r.err.split('\n').slice(-2).join(' ').trim()}`)
  }

  // Warn, never fail: a repo that is not yet a Datacore space is a normal thing
  // to adopt, and deleting someone's successful clone over a missing folder
  // would be the wrong trade.
  const warnings: string[] = []
  const looksLikeSpace = existsSync(join(spacePath, '.datacore'))
    || existsSync(join(spacePath, 'CLAUDE.base.md'))
    || existsSync(join(spacePath, 'CLAUDE.md'))
    || existsSync(join(spacePath, 'org'))
  if (!looksLikeSpace) {
    warnings.push('No .datacore/, CLAUDE.md or org/ — this repo may not be a Datacore space yet. `datacore space audit` lists what is missing.')
  }

  return {
    space: {
      name: folderName,
      number,
      path: spacePath,
      type: number === 0 ? 'personal' : 'team',
      hasGit: true,
      hasClaude: existsSync(join(spacePath, 'CLAUDE.md')) || existsSync(join(spacePath, 'CLAUDE.base.md')),
    },
    warnings,
  }
}
