/**
 * Init wizard for Datacore setup (v2).
 *
 * Zero-friction bootstrapper: auto-installs all dependencies, configures
 * git, forks & clones the repo, sets up spaces and modules, imports data,
 * and verifies the installation.
 *
 * 9-step flow:
 *   1. About You        - Name, email, use case, role
 *   2. System Setup     - Auto-install all dependencies
 *   3. Repository       - Fork & clone
 *   4. Team Spaces      - Optional team spaces
 *   5. Your Second Brain - Education + personal space setup
 *   6. Modules          - All selected by default, deselect to remove
 *   7. Finalize         - CLAUDE.md, DB, state, install.yaml, snapshot
 *   8. Import Data      - ChatGPT, documents, notes
 *   9. Verification     - Claude Code structural check
 */

import { existsSync, mkdirSync, writeFileSync, symlinkSync, copyFileSync, readdirSync, readFileSync, statSync, cpSync } from 'fs'
import { join, basename } from 'path'
import { execFileSync } from 'child_process'
import { createInterface } from 'readline'
import { detectPlatform, getInstallCommand, type Platform } from './platform'
import { AVAILABLE_MODULES, installModule, listModules } from './module'
import { listSpaces } from './space'
import { invokeAgent } from './agent'
import { FALLBACK_NPM_PREFIX, resolveBinary, unresolvableMcpServers } from './upgrade'
import { createSnapshot, saveSnapshot } from './snapshot'
import { startOperation } from '../state'
import { BANNER, INIT_COMPLETE, Spinner, sleep, section, completionSequence } from './animation'
import { spawnBackground, type BackgroundJob } from './background'

// ─── Constants ────────────────────────────────────────────────────────────────

// Honour DATACORE_ROOT, as paths.ts:dataDir() already did and this file did not.
// The divergence made the installer untestable: a run against a temp root
// silently resolved to the real ~/Data, found it initialised, and returned
// success having created nothing — so every install bug had to be found by a
// human on a clean laptop. Read at module load, which is correct for an env var
// the caller sets before starting the process (see the init smoke test).
import { ensureDatacoreVenv, ensureModuleDeps, pipInstallInto, venvPython } from './python-env'

const DATA_DIR = process.env.DATACORE_ROOT || join(process.env.HOME || '', 'Data')
const DATACORE_DIR = join(DATA_DIR, '.datacore')
const UPSTREAM_REPO = 'datacore-one/datacore'
const TOTAL_STEPS = 10

/**
 * Known team spaces that users can select during init.
 * Private repos require GitHub auth (set up in Step 2).
 */
interface KnownSpace {
  name: string
  displayName: string
  description: string
  repo: string
  /** GitHub org/user that owns the repo (for access check) */
  org: string
  /** If true, repo is private and requires collaborator access */
  private: boolean
}

const KNOWN_SPACES: KnownSpace[] = [
  {
    name: 'datafund',
    displayName: 'Datafund',
    description: 'Datafund organization workspace',
    repo: 'https://github.com/datacore-one/datafund-space.git',
    org: 'datacore-one',
    private: true,
  },
  {
    name: 'fds',
    displayName: 'Fair Data Society',
    description: 'FDS projects - Fairdrive, Fairdrop, fairOS, identity',
    repo: 'https://github.com/fairDataSociety/fds-space.git',
    org: 'fairDataSociety',
    private: false,
  },
  {
    name: 'datacore',
    displayName: 'Datacore',
    description: 'Datacore system development - specs, CLI, modules',
    repo: 'https://github.com/datacore-one/datacore-space.git',
    org: 'datacore-one',
    private: false,
  },
]

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * What an agent should ask the user before calling `init --answers`.
 *
 * Published by `datacore init --print-questions` so the agent does not hardcode
 * the wizard's questions and the two cannot drift apart. Each entry says what to
 * ask, what shape the answer takes, and — the part that matters — what happens
 * if it is left out, so an agent can decide whether a question is worth asking
 * this particular person.
 */
export const INIT_QUESTIONS = {
  version: 1,
  usage: 'Ask these in natural language, write the answers as JSON, then run: datacore init --answers <file>',
  questions: [
    {
      key: 'name', type: 'string', required: false,
      ask: 'What name should Datacore use for you?',
      default: 'from git config user.name',
    },
    {
      key: 'email', type: 'string', required: false,
      ask: 'Which email should sign your git commits? Use one on your GitHub account, or GitHub will not link the commits to you.',
      default: 'git config user.email, else the GitHub noreply address of the signed-in gh account',
      note: 'This becomes `git config --global user.email` and nothing else. An address GitHub does not know produces commits attributed to nobody, which is invisible until someone reads a contribution graph.',
    },
    {
      key: 'useCase', type: 'enum', required: false,
      values: ['personal', 'team', 'both'],
      ask: 'Is this for personal use, team use, or both?',
      default: 'both',
    },
    {
      key: 'modules', type: 'string[]', required: false,
      ask: 'Which modules do you want? Run `datacore module list` for what is available.',
      default: 'every public module in the catalog',
      note: 'Private modules are never installed unless named explicitly — they cannot be cloned without org access and produce one error line each.',
    },
    {
      key: 'cosName', type: 'string', required: false,
      ask: 'What should your Chief of Staff be called?',
      default: 'Winston',
      note: 'Worth asking. Taking this default silently is the specific thing the non-TTY guard exists to prevent.',
    },
    {
      key: 'cosPersonality', type: 'string', required: false,
      ask: 'Anything about how it should talk to you?',
      default: 'none',
    },
    {
      key: 'spaces', type: 'string[]', required: false,
      ask: 'Any team spaces to create now? (you can add them later)',
      default: 'none beyond 0-personal',
    },
  ],
  example: {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    useCase: 'both',
    modules: ['news', 'research', 'meetings'],
    cosName: 'Babbage',
    cosPersonality: 'Brief. Lead with the decision.',
    spaces: [],
  },
} as const

export interface InitOptions {
  /** Skip interactive prompts, use defaults */
  nonInteractive?: boolean
  /** Skip dependency checks */
  skipChecks?: boolean
  /** Stream output (enables animations in TTY) */
  stream?: boolean
  /** Show verbose output (PIDs, log paths) */
  verbose?: boolean
  /** Force re-initialization (init git in non-empty dirs, re-run all steps) */
  force?: boolean
  /**
   * Answers gathered elsewhere — by an agent asking the user in natural
   * language — instead of by this wizard's prompts.
   *
   * There were only two modes before this, and both are wrong for an agent
   * driving the install. The TTY wizard cannot be typed into by a program, and
   * `--yes` takes every default in silence: the user is never asked their name,
   * their modules, or what to call their Chief of Staff, and non-interactive
   * mode additionally tries to install EVERY module including the private ones,
   * which fail to clone for anyone outside the org.
   *
   * With answers supplied, the run is non-interactive but nothing is defaulted
   * silently — every value was chosen by a human, just not at a prompt.
   */
  answers?: InitAnswers
}

/** What the wizard would have asked. See `datacore init --print-questions`. */
export interface InitAnswers {
  name?: string
  email?: string
  useCase?: 'personal' | 'team' | 'both'
  /** Module names to install. Omit for "every public module in the catalog". */
  modules?: string[]
  /** What the Chief of Staff is called. */
  cosName?: string
  cosPersonality?: string
  /** Team spaces to create, by name. */
  spaces?: string[]
}

export interface InitResult {
  success: boolean
  created: string[]
  configured: string[]
  warnings: string[]
  errors: string[]
  nextSteps: string[]
  spacesCreated: string[]
  modulesInstalled: string[]
}

/** User profile collected during personalization step. */
interface UserProfile {
  name: string
  email: string
  useCase: 'personal' | 'team' | 'both'
  role: string
}

// ─── ANSI Colors ──────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
}

// ─── Helpers: Prompts ─────────────────────────────────────────────────────────

export async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    const defaultHint = defaultValue ? ` [${defaultValue}]` : ''
    rl.question(`${question}${defaultHint}: `, (answer) => {
      rl.close()
      resolve(answer.trim() || defaultValue || '')
    })
  })
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]'
  const answer = await prompt(`${question} ${hint}`)
  if (!answer) return defaultYes
  return answer.toLowerCase().startsWith('y')
}

export async function choose(question: string, options: string[], defaultIndex = 0): Promise<number> {
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIndex ? `${c.cyan}>${c.reset}` : ' '
    console.log(`  ${marker} ${c.cyan}${i + 1}${c.reset}) ${options[i]}`)
  }
  console.log()
  const answer = await prompt(question, String(defaultIndex + 1))
  const num = parseInt(answer, 10)
  if (num >= 1 && num <= options.length) return num - 1
  return defaultIndex
}

// ─── Helpers: Shell ───────────────────────────────────────────────────────────

function runArgs(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'pipe', cwd: opts?.cwd, timeout: opts?.timeout })
    return true
  } catch {
    return false
  }
}

/** Like runArgs but returns stderr on failure for diagnostic messages. */
function runArgsWithError(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }): { ok: boolean; stderr?: string } {
  try {
    execFileSync(cmd, args, { stdio: 'pipe', cwd: opts?.cwd, timeout: opts?.timeout })
    return { ok: true }
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string })?.stderr?.toString().trim() || ''
    return { ok: false, stderr }
  }
}

/**
 * Initialize git in an existing non-empty directory by fetching from remote.
 * Used when git clone fails because the directory already has content.
 */
function initGitInDir(repoUrl: string, dir: string, timeout = 300000): { ok: boolean; stderr?: string } {
  let r = runArgsWithError('git', ['init'], { cwd: dir, timeout: 30000 })
  if (!r.ok) return r

  // Add origin (set-url if it already exists from a previous attempt)
  r = runArgsWithError('git', ['remote', 'add', 'origin', repoUrl], { cwd: dir, timeout: 5000 })
  if (!r.ok) {
    r = runArgsWithError('git', ['remote', 'set-url', 'origin', repoUrl], { cwd: dir, timeout: 5000 })
    if (!r.ok) return r
  }

  r = runArgsWithError('git', ['fetch', 'origin'], { cwd: dir, timeout })
  if (!r.ok) return r

  // Determine default branch from remote HEAD
  const headRef = runArgsOutput('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { timeout: 5000 })
  const branch = headRef?.replace('refs/remotes/origin/', '') || 'main'

  // Reset index to match remote (preserves working tree as-is)
  r = runArgsWithError('git', ['reset', `origin/${branch}`], { cwd: dir, timeout: 30000 })
  if (!r.ok) return r

  // Set up branch tracking
  runArgs('git', ['branch', '-M', branch], { cwd: dir })
  runArgs('git', ['branch', '--set-upstream-to', `origin/${branch}`], { cwd: dir })

  // Checkout repo files - restores any missing system files from remote
  // Tracked files that exist locally and differ will be overwritten (intended for --force)
  runArgs('git', ['checkout', '--', '.'], { cwd: dir, timeout: 60000 })

  return { ok: true }
}

function runArgsOutput(cmd: string, args: string[], opts?: { timeout?: number }): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', stdio: 'pipe', timeout: opts?.timeout }).trim()
  } catch {
    return ''
  }
}

function commandExists(cmd: string): boolean {
  // resolveBinary also looks in npm's configured prefix and our fallback
  // prefix. `which` alone reported binaries as missing that were installed
  // and working, purely because the prefix bin was not on PATH.
  if (resolveBinary(cmd)) return true
  try {
    execFileSync('which', [cmd], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function getVersionString(cmd: string, flag = '--version'): string | undefined {
  try {
    const output = execFileSync(cmd, [flag], { encoding: 'utf-8', stdio: 'pipe' })
    return output.match(/(\d+\.\d+(\.\d+)?)/)?.[0] ?? output.trim().split('\n')[0]?.slice(0, 30)
  } catch {
    return undefined
  }
}

// ─── Helpers: Git & GitHub ────────────────────────────────────────────────────

function checkGhAuth(): { available: boolean; user?: string } {
  if (!commandExists('gh')) return { available: false }
  try {
    const output = execFileSync('gh', ['auth', 'status'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 })
    const combined = output
    const userMatch = combined.match(/Logged in to github\.com.*account (\S+)/i)
    return { available: true, user: userMatch?.[1] }
  } catch (err) {
    // gh auth status writes to stderr even on success in some versions
    const stderr = (err as { stderr?: Buffer | string })?.stderr?.toString() || ''
    const userMatch = stderr.match(/Logged in to github\.com.*account (\S+)/i)
    if (userMatch) return { available: true, user: userMatch[1] }
    return { available: false }
  }
}

/**
 * The Chief of Staff's name, read back from the persona this install wrote.
 *
 * `cosName` lives on InitAnswers, not on the profile, and an interactive run
 * never puts it there at all -- it is typed at a prompt inside the persona
 * step. Reading the file is both simpler and truer: it reports the assistant
 * that exists, including the one a re-run deliberately left alone.
 */
function cosPersonaName(): string {
  try {
    const f = join(DATACORE_DIR, 'personas', 'winston.md')
    if (!existsSync(f)) return 'Winston'
    const head = readFileSync(f, 'utf-8').slice(0, 2000)
    // The name is `displayName:` in the frontmatter. Reading the first H1
    // instead found nothing and fell back to the default, so an install whose
    // owner named their Chief of Staff Babbage was greeted by Winston -- the
    // single most visible thing about the feature, wrong. The H1 is kept as a
    // second chance for a hand-written persona that has no frontmatter.
    return head.match(/^displayName:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '')
      || head.match(/^#\s+(.+)$/m)?.[1]?.trim().split(/[\u2014,-]/)[0]?.trim()
      || 'Winston'
  } catch {
    return 'Winston'
  }
}

/**
 * Is this MCP server actually registered?
 *
 * `~/Data/.mcp.json` is the file `configureMcpForCode` writes and the file
 * install.txt tells agents to check. This read `~/.claude.json`, which has no
 * `mcpServers` key at all -- so it returned false on a correct install, every
 * time. The completion line said "Memory: not connected" and the first-run
 * marker carried `memoryConnected: false`, which made the assistant open its
 * very first sentence to a new user by announcing that nothing they say will
 * be remembered. A check that is wrong in the alarming direction is worse than
 * no check: it teaches people to distrust a working system.
 *
 * Claude Desktop's config is accepted too -- a user who wired only that has a
 * working memory server, whatever the Code config says.
 */
function mcpConfigured(name: string): boolean {
  const home = process.env.HOME || ''
  const candidates = [
    join(DATA_DIR, '.mcp.json'),
    join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    join(home, '.config', 'Claude', 'claude_desktop_config.json'),
  ]
  for (const cfgPath of candidates) {
    try {
      if (!existsSync(cfgPath)) continue
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { mcpServers?: Record<string, unknown> }
      if (cfg.mcpServers?.[name]) return true
    } catch {
      // A malformed config is not proof of absence; try the next one.
    }
  }
  return false
}

/**
 * Point the shipped Claude Code hooks at THIS installation.
 *
 * `.datacore/settings.json` ships with 26 hook commands, every one of them
 * spelling the path out as `python3 ~/Data/.datacore/lib/...`. That is correct
 * for the default location and wrong everywhere else: an install created with
 * `--path` or DATACORE_ROOT gets a settings file whose hooks all reach into
 * ~/Data, so they either run the WRONG installation's code or silently do
 * nothing. Session bootstrap, engram injection, the date guard, the wrap-up
 * gate -- none of them belong to the install that just ran.
 *
 * `${CLAUDE_PROJECT_DIR}` would be the elegant fix and is not safe here: it
 * resolves to where the session started, so a session opened inside a project
 * folder would resolve it to that folder rather than the installation root.
 * Rewriting once, at install time, has no such failure mode.
 *
 * For a default install this is a literal no-op: the paths already say ~/Data,
 * nothing changes, and the tracked file stays clean.
 */
function localiseHookPaths(isTTY: boolean | undefined, result: InitResult): void {
  const settingsPath = join(DATACORE_DIR, 'settings.json')
  if (!existsSync(settingsPath)) return

  const home = process.env.HOME || ''
  const defaultRoot = join(home, 'Data')
  if (DATA_DIR === defaultRoot) return  // nothing to rewrite

  try {
    const before = readFileSync(settingsPath, 'utf-8')
    // Both spellings appear in the wild: the literal tilde and the expanded
    // home path. Replace each with this installation's root.
    const after = before
      .split('~/Data/').join(`${DATA_DIR}/`)
      .split(`${defaultRoot}/`).join(`${DATA_DIR}/`)
    if (after === before) return

    JSON.parse(after)  // never write a settings file that will not parse
    writeFileSync(settingsPath, after)
    if (isTTY) {
      console.log(`  ${c.green}✓${c.reset} hook paths point at ${c.dim}${DATA_DIR}${c.reset}`)
    }
    result.configured.push('Claude Code hook paths localised')
  } catch (err) {
    result.warnings.push(
      `Could not point hook paths at ${DATA_DIR}: ${(err as Error).message}. ` +
      'Hooks may run against ~/Data instead of this installation.')
  }
}

/** Is core.hooksPath pointed at the repo's own hooks? */
function gitHooksConfigured(): boolean {
  return !!runArgsOutput('git', ['-C', DATA_DIR, 'config', 'core.hooksPath'])
}

function isGitConfigured(): { name?: string; email?: string; configured: boolean } {
  const name = runArgsOutput('git', ['config', '--global', 'user.name'])
  const email = runArgsOutput('git', ['config', '--global', 'user.email'])
  return { name: name || undefined, email: email || undefined, configured: !!(name && email) }
}

/**
 * The GitHub account's commit identity, if `gh` is already authenticated.
 *
 * The email this wizard collects does exactly one thing: it becomes
 * `git config --global user.email`. That is the address GitHub matches commits
 * against, so an address not on the user's account produces commits GitHub
 * shows as an anonymous grey avatar forever. Asking for "your email" invites
 * precisely that answer, and the mistake is invisible until someone looks at a
 * contribution graph months later.
 *
 * We default to the account's `noreply` address rather than a real one. It
 * always attributes correctly, it needs no scope beyond what `gh auth login`
 * already grants (`/user` is public; `/user/emails` would require asking for
 * `user`), and it keeps a private address out of commit history that may well
 * become public. Anyone who wants their real address types it over the top.
 */
function githubIdentity(): { login: string; noreply: string } | null {
  if (!commandExists('gh')) return null
  const raw = runArgsOutput('gh', ['api', 'user', '--jq', '{login: .login, id: .id}'], { timeout: 10000 })
  if (!raw) return null
  try {
    const { login, id } = JSON.parse(raw) as { login?: string; id?: number }
    if (!login || typeof id !== 'number') return null
    return { login, noreply: `${id}+${login}@users.noreply.github.com` }
  } catch {
    return null
  }
}

// ─── Helpers: Dependencies ────────────────────────────────────────────────────

/**
 * Attempt to install a system dependency.
 * Returns success and version after install.
 */
/** `3.9.6` / `v24.21.0` / `git version 2.50.1` -> [3,9,6] */
function parseVersion(s: string | undefined): number[] {
  const m = (s ?? '').match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : []
}

function versionAtLeast(found: string | undefined, min: string): boolean {
  const f = parseVersion(found), m = parseVersion(min)
  if (!f.length) return false
  for (let i = 0; i < m.length; i++) {
    if ((f[i] ?? 0) > (m[i] ?? 0)) return true
    if ((f[i] ?? 0) < (m[i] ?? 0)) return false
  }
  return true
}

async function ensureDependency(
  name: string,
  checkCmd: string,
  platform: Platform,
  isTTY: boolean,
  versionFlag = '--version',
  minVersion?: string,
): Promise<{ available: boolean; version?: string; wasInstalled: boolean; tooOld?: boolean }> {
  // Already available AND new enough?
  //
  // Presence alone was the test until 2026-09-21, and on macOS that made the
  // Python check unfalsifiable: /usr/bin/python3 always exists and is 3.9, so
  // `brew install python@3.11` — configured right there in platform.ts — could
  // never run. The install then "succeeded" and failed later with a syntax
  // error from PEP-604 unions, pointing at the wrong thing entirely.
  if (commandExists(checkCmd)) {
    const version = getVersionString(checkCmd, versionFlag)
    if (!minVersion || versionAtLeast(version, minVersion)) {
      return { available: true, version, wasInstalled: false }
    }
    if (isTTY) {
      console.log(`  ${c.yellow}!${c.reset} ${name} ${version} is older than ${minVersion} — upgrading`)
    }
  }

  // Get install command
  const installCmd = getInstallCommand(name, platform)
  if (!installCmd) {
    return { available: false, wasInstalled: false }
  }

  // SHOW THE WORK. `stdio: 'pipe'` discarded everything the install printed, so
  // a 20-second bottle download and an 8-hour source build looked identical: a
  // static spinner. On the first external install that ambiguity, not any single
  // bug, is what made the user believe the machine had frozen. Homebrew can also
  // prompt (sudo, Xcode CLT) and with stdin unattached that wait is invisible
  // and unanswerable.
  //
  // So: name the command, stream its output, and report elapsed time as it runs.
  if (isTTY) {
    console.log(`  ${c.dim}installing ${name}: ${installCmd}${c.reset}`)
    console.log(`  ${c.dim}(streaming below — this can take a few minutes)${c.reset}`)
  }
  const started = Date.now()
  const ticker = isTTY ? setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000)
    if (s >= 30 && s % 30 === 0) process.stdout.write(`  ${c.dim}… still installing ${name} (${s}s)${c.reset}\n`)
  }, 1000) : null

  try {
    // Install commands may contain shell operators (pipes, &&), so use bash.
    // `inherit` also connects stdin, so a prompt can actually be answered.
    execFileSync('/bin/bash', ['-c', installCmd],
                 { stdio: isTTY ? 'inherit' : 'pipe', timeout: 900000 })

    if (ticker) clearInterval(ticker)
    // Verify it's now available
    if (commandExists(checkCmd)) {
      const version = getVersionString(checkCmd, versionFlag)
      if (isTTY) console.log(`  ${c.green}✓${c.reset} ${name} installed${version ? ` (${version})` : ''}`)
      return { available: true, version, wasInstalled: true }
    }

    if (isTTY) console.log(`  ${c.yellow}⚠${c.reset} ${name} install completed but command not found in PATH`)
    if (isTTY) console.log(`    ${c.dim}Try manually: ${installCmd}${c.reset}`)
    return { available: false, wasInstalled: false }
  } catch (e) {
    if (ticker) clearInterval(ticker)
    // Say WHY. A bare "failed to install" on a machine whose npm prefix is
    // root-owned (the default for a system-wide node, so most Linux boxes and
    // every clean container) sends people hunting for a network or registry
    // problem. The install is fine; the directory is not writable.
    const detail = String((e as { stderr?: Buffer }).stderr ?? (e as Error).message ?? '')
    const permissionDenied = /EACCES|permission denied|EPERM/i.test(detail)
    if (isTTY) console.log(`  ${c.red}✗${c.reset} Failed to install ${name}`)
    if (permissionDenied && installCmd.startsWith('npm install -g ')) {
      // Retry into a prefix WE own rather than asking for sudo. The MCP config
      // records absolute paths, so a binary here works without the user ever
      // touching PATH — which is the half of the usual remedy people skip,
      // and the reason an install could look complete and launch nothing.
      const pkg = installCmd.replace('npm install -g ', '').trim()
      const fallbackBin = join(FALLBACK_NPM_PREFIX, 'bin', checkCmd)
      try {
        mkdirSync(FALLBACK_NPM_PREFIX, { recursive: true })
        execFileSync('npm', ['install', '--prefix', FALLBACK_NPM_PREFIX, '-g', pkg],
                     { stdio: 'pipe', timeout: 300000 })
      } catch { /* fall through to the report below */ }
      if (existsSync(fallbackBin)) {
        const version = getVersionString(fallbackBin, versionFlag)
        if (isTTY) console.log(`  ${c.green}✓${c.reset} ${name} installed${version ? ` (${version})` : ''} (user prefix)`)
        userPrefixInstalls.push(name)
        return { available: true, version, wasInstalled: true }
      }
      const hint = `npm's global directory is not writable and the user-prefix fallback also failed for ${name}.`
      if (isTTY) {
        console.log(`    ${c.dim}${hint}${c.reset}`)
        console.log(`    ${c.dim}Try: sudo ${installCmd}${c.reset}`)
      }
      permissionFailures.push(`${name}: sudo ${installCmd}`)
    } else if (permissionDenied) {
      const hint = `npm's global directory is not writable by this user, so ${name} could not be installed.`
      if (isTTY) {
        console.log(`    ${c.dim}${hint}${c.reset}`)
        console.log(`    ${c.dim}Try: sudo ${installCmd}${c.reset}`)
      }
      permissionFailures.push(`${name}: sudo ${installCmd}`)
    } else if (isTTY) {
      console.log(`    ${c.dim}Try manually: ${installCmd}${c.reset}`)
    }
    return { available: false, wasInstalled: false }
  }
}

/** Dependencies that failed specifically because npm's global dir is not
 *  writable. Collected so init reports one actionable cause instead of a
 *  list of failures that each look like their own unrelated problem. */
const permissionFailures: string[] = []

/** Installed into ~/.datacore/npm because the global prefix was read-only.
 *  Reported so the user knows where their binaries went. */
const userPrefixInstalls: string[] = []

/**
 * Ensure Homebrew is available on macOS (required for other installs).
 */
async function ensureHomebrew(isTTY: boolean): Promise<boolean> {
  if (commandExists('brew')) return true

  // Check common alternate locations
  const brewPaths = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']
  for (const p of brewPaths) {
    if (existsSync(p)) {
      // Add to PATH for this session
      const dir = join(p, '..')
      process.env.PATH = `${dir}:${process.env.PATH}`
      return true
    }
  }

  const spinner = isTTY ? new Spinner('Installing Homebrew...') : null
  spinner?.start()

  try {
    execFileSync('/bin/bash', ['-c', 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'], {
      stdio: 'pipe',
      timeout: 600000,
    })

    // Add to PATH
    for (const p of brewPaths) {
      if (existsSync(p)) {
        const dir = join(p, '..')
        process.env.PATH = `${dir}:${process.env.PATH}`
        break
      }
    }

    if (commandExists('brew')) {
      spinner?.succeed('Homebrew installed')
      return true
    }

    spinner?.fail('Homebrew installed but not found in PATH')
    return false
  } catch {
    spinner?.fail('Failed to install Homebrew')
    if (isTTY) {
      console.log(`    ${c.dim}Install manually: https://brew.sh${c.reset}`)
    }
    return false
  }
}

// ─── Helpers: Modules ─────────────────────────────────────────────────────────

/**
 * Run post-install dependencies for a module.
 * Checks for requirements.txt, package.json, or install.sh.
 */
export function runModulePostInstall(modulePath: string): { ran: boolean; success: boolean; type?: string } {
  // Check for Python dependencies
  const reqTxt = join(modulePath, 'requirements.txt')
  if (existsSync(reqTxt)) {
    // Into .datacore/venv when it exists: Homebrew Python refuses a
    // system-wide pip install (PEP 668), which failed every module's deps.
    const venvPy = venvPython(DATA_DIR)
    const ok = existsSync(venvPy)
      ? pipInstallInto(venvPy, reqTxt).ok
      : runArgs('python3', ['-m', 'pip', 'install', '-r', reqTxt, '--quiet'], { cwd: modulePath, timeout: 120000 })
    return { ran: true, success: ok, type: 'pip' }
  }

  // Check for Node.js dependencies
  const pkgJson = join(modulePath, 'package.json')
  if (existsSync(pkgJson)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8'))
      if (pkg.dependencies || pkg.devDependencies) {
        const ok = runArgs('npm', ['install', '--silent'], { cwd: modulePath, timeout: 120000 })
        return { ran: true, success: ok, type: 'npm' }
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Check for install script
  const installSh = join(modulePath, 'install.sh')
  if (existsSync(installSh)) {
    const ok = runArgs('bash', [installSh], { cwd: modulePath })
    return { ran: true, success: ok, type: 'script' }
  }

  // Check in subdirectories (e.g., mcp-server/)
  try {
    const entries = readdirSync(modulePath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const subPkg = join(modulePath, entry.name, 'package.json')
      if (existsSync(subPkg)) {
        try {
          const pkg = JSON.parse(readFileSync(subPkg, 'utf-8'))
          if (pkg.dependencies || pkg.devDependencies) {
            const ok = runArgs('npm', ['install', '--silent'], { cwd: join(modulePath, entry.name), timeout: 120000 })
            return { ran: true, success: ok, type: 'npm' }
          }
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore
  }

  return { ran: false, success: true }
}

// ─── Helpers: Files ───────────────────────────────────────────────────────────

/**
 * Count files recursively in a directory.
 */
function countFiles(dir: string): { total: number; byExt: Record<string, number> } {
  let total = 0
  const byExt: Record<string, number> = {}

  function walk(d: string) {
    try {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const fullPath = join(d, entry.name)
        if (entry.isFile()) {
          total++
          const ext = entry.name.includes('.') ? entry.name.split('.').pop()!.toLowerCase() : 'other'
          byExt[ext] = (byExt[ext] || 0) + 1
        } else if (entry.isDirectory()) {
          walk(fullPath)
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  walk(dir)
  return { total, byExt }
}

/**
 * True when ~/Data holds nothing but this installer's own bookkeeping.
 *
 * init starts an operation log at $DATA_DIR/.datacore/state before it clones,
 * so on a genuinely fresh machine the directory is non-empty by the time git
 * runs and the clone refuses with "already exists and is not an empty
 * directory". The install then demands --force on a first run, against a
 * directory nothing but init had ever touched.
 *
 * This never sees a dev machine, where ~/Data is already a git repo and the
 * clone takes an entirely different branch. It took a clean container.
 *
 * Deliberately narrow: ONLY our own state counts as empty. Anything the user
 * put there still stops the clone, which is the protection that matters.
 */
function containsOnlyOwnState(dir: string): boolean {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  if (entries.length === 0) return true
  if (entries.length > 1 || entries[0] !== '.datacore') return false
  try {
    const inner = readdirSync(join(dir, '.datacore'))
    return inner.every(e => e === 'state')
  } catch {
    return false
  }
}

// ─── Helpers: Chief of Staff ─────────────────────────────────────────────────

/** Tone presets. Free text is always allowed; these just save typing. */
const COS_TONES: { label: string; line: string }[] = [
  { label: 'Direct — says the thing, no preamble',
    line: 'Be direct. Lead with the answer, then the reasoning. No preamble, no filler.' },
  { label: 'Warm — encouraging, still honest',
    line: 'Be warm and encouraging without softening bad news. Say hard things kindly, not vaguely.' },
  { label: 'Formal — precise, analytical',
    line: 'Be formal and precise. Prefer analysis to opinion. Avoid contractions and colloquialisms.' },
  { label: 'Dry — brief, understated wit',
    line: 'Be brief and dry. Understatement over enthusiasm. Never pad a short answer.' },
]

/**
 * Name the Chief of Staff and give it a personality.
 *
 * THE SLUG STAYS `winston`. The chief-of-staff module, the app's agent
 * registry and the server all reference that slug; renaming the file would
 * unwire them and the user would get a differently-named assistant that no
 * longer runs their briefing. The chosen name is `displayName` — what the
 * user sees — while the slug remains the stable wiring identifier.
 *
 * Written to $DATACORE_ROOT/.datacore/personas/, which both persona loaders
 * prefer over the bundled set, so the customisation survives upgrades.
 */
async function configureChiefOfStaff(isTTY: boolean | undefined, result: InitResult,
                                     answers?: InitAnswers): Promise<void> {
  const personasDir = join(DATACORE_DIR, 'personas')
  const target = join(personasDir, 'winston.md')

  let name = 'Winston'
  let tone = COS_TONES[0]!.line
  let extra = ''

  // A name the user chose, gathered by an agent rather than at a prompt. The
  // default being taken silently is the specific thing the non-TTY guard
  // exists to prevent, so honouring an explicit answer here is the point.
  if (answers?.cosName || answers?.cosPersonality) {
    if (answers.cosName) name = answers.cosName.trim() || 'Winston'
    if (answers.cosPersonality) extra = answers.cosPersonality.trim()
  } else if (isTTY) {
    name = (await prompt('  What should your Chief of Staff be called', 'Winston')).trim() || 'Winston'
    const idx = await choose('  Tone', COS_TONES.map(t => t.label), 0)
    tone = (COS_TONES[idx] ?? COS_TONES[0]!).line
    console.log()
    console.log(`  ${c.dim}Anything else it should know about how you want to be worked with?${c.reset}`)
    console.log(`  ${c.dim}(e.g. "I trade in the mornings, never schedule before 10am." Enter to skip)${c.reset}`)
    extra = (await prompt('  Personality notes', '')).trim()
  }

  if (existsSync(target)) {
    // Never clobber a personality the user already wrote. Re-running init is
    // a routine repair action and must not silently reset their assistant.
    if (isTTY) console.log(`  ${c.green}✓${c.reset} Chief of Staff ${c.dim}(existing personality kept)${c.reset}`)
    result.configured.push('Chief of Staff persona (existing kept)')
    return
  }

  try {
    mkdirSync(personasDir, { recursive: true })
    const body = [
      '---',
      `displayName: ${name}`,
      'role: Chief of Staff',
      '---',
      '',
      `You are ${name}, the principal's Chief of Staff.`,
      '',
      tone,
      '',
      extra ? `How they want to be worked with: ${extra}` : '',
      '',
      'You act only through the approvals queue. Nothing side-effecting happens',
      'without the principal deciding it.',
      '',
    ].filter(l => l !== undefined).join('\n')
    writeFileSync(target, body.replace(/\n{3,}/g, '\n\n'))
    if (isTTY) console.log(`  ${c.green}✓${c.reset} ${name} configured ${c.dim}(${target})${c.reset}`)
    result.configured.push(`Chief of Staff: ${name}`)
    result.nextSteps.push(`Edit ${name}'s personality any time: ${target}`)
  } catch (e) {
    result.warnings.push(`Could not write the Chief of Staff persona: ${(e as Error).message}`)
  }
}

// ─── Helpers: Desktop app ────────────────────────────────────────────────────

/** Where the desktop build is published.
 *
 * The .html is load-bearing: datacore.one serves real pages only at their
 * exact filename and falls back to the HOMEPAGE for anything else, with a
 * 200. So `/app` did not 404 — it quietly served the front page, which looks
 * like the link working right up until the user wonders where the download
 * went. An extensionless URL here is a silent wrong answer.
 */
const DESKTOP_APP_URL = 'https://datacore.one/app.html'

/**
 * Offer the desktop app as the last thing, once the install works.
 *
 * Offered rather than installed: it is a GUI download, and a CLI that opens
 * a browser window without asking is a surprise at the end of a long flow.
 * Declining leaves a working terminal install, which is the supported path.
 */
async function offerDesktopApp(isTTY: boolean | undefined, result: InitResult): Promise<void> {
  if (!isTTY) {
    result.nextSteps.push(`Desktop app (optional): ${DESKTOP_APP_URL}`)
    return
  }
  console.log()
  console.log(`  ${c.bold}Desktop app${c.reset}`)
  console.log(`  ${c.dim}Datacore also runs as a desktop app \u2014 the same second brain with`)
  console.log(`  panels, chat and your Chief of Staff in one window.${c.reset}`)
  console.log()
  if (await confirm('  Open the download page now?', false)) {
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open'
    if (!runArgs(opener, [DESKTOP_APP_URL])) {
      console.log(`  ${c.dim}Could not open a browser. Visit: ${DESKTOP_APP_URL}${c.reset}`)
    }
  }
  result.nextSteps.push(`Desktop app (optional): ${DESKTOP_APP_URL}`)
}

// ─── Helpers: MCP Configuration ──────────────────────────────────────────────

/**
 * Configure MCP server for Claude Desktop and Claude Code.
 * Reads, merges, and writes config files idempotently (preserves existing entries).
 */
function configureMcpServer(isTTY: boolean | undefined, result: InitResult): void {
  const { configureMcpForCode, configureMcpForDesktop } = require('./upgrade')
  const updateResult = { updated: [] as string[], warnings: [] as string[], alreadyCurrent: [] as string[] }

  configureMcpForDesktop(!!isTTY, updateResult)
  configureMcpForCode(!!isTTY, updateResult)

  // Transfer warnings to init result
  for (const w of updateResult.warnings) {
    result.warnings.push(w)
  }
}

/**
 * Ask the user which permission safety level they want for Claude Code.
 * Writes appropriate `ask` rules to .claude/settings.local.json.
 */
async function configurePermissionPreference(result: InitResult): Promise<void> {
  console.log()
  console.log(`  ${c.bold}Permission Safety Level${c.reset}`)
  console.log(`  ${c.dim}Controls which commands Claude asks before running.${c.reset}`)
  console.log()

  const choice = await choose('  Select safety level', [
    `Behavioral only     ${c.dim}— trust CLAUDE.md instructions, no extra ask rules${c.reset}`,
    `Light guardrails     ${c.dim}— ask before rm, force push, reset --hard (recommended)${c.reset}`,
    `Moderate guardrails  ${c.dim}— also ask before ssh, curl, docker, kill${c.reset}`,
    `Strict               ${c.dim}— ask before most system commands${c.reset}`,
  ], 1)

  const askRules: Record<number, string[]> = {
    0: [],  // Behavioral only — no ask rules
    1: [    // Light guardrails
      'Bash(rm *)',
      'Bash(git push --force *)',
      'Bash(git push -f *)',
      'Bash(git reset --hard *)',
      'Bash(git clean *)',
      'Bash(git checkout -- *)',
    ],
    2: [    // Moderate guardrails
      'Bash(rm *)',
      'Bash(git push --force *)',
      'Bash(git push -f *)',
      'Bash(git reset --hard *)',
      'Bash(git clean *)',
      'Bash(git checkout -- *)',
      'Bash(ssh *)',
      'Bash(curl *)',
      'Bash(docker *)',
      'Bash(kill *)',
      'Bash(pkill *)',
    ],
    3: [    // Strict
      'Bash(rm *)',
      'Bash(git push *)',
      'Bash(git reset *)',
      'Bash(git clean *)',
      'Bash(git checkout -- *)',
      'Bash(ssh *)',
      'Bash(scp *)',
      'Bash(rsync *)',
      'Bash(curl *)',
      'Bash(docker *)',
      'Bash(kill *)',
      'Bash(pkill *)',
      'Bash(chmod *)',
      'Bash(mv *)',
      'Bash(cp *)',
    ],
  }

  const rules = askRules[choice] ?? []

  if (rules.length === 0) {
    console.log(`  ${c.green}✓${c.reset} No additional safety rules`)
    return
  }

  const claudeDir = join(DATA_DIR, '.claude')
  const settingsPath = join(claudeDir, 'settings.local.json')

  try {
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true })
    }

    let config: Record<string, unknown> = {}
    if (existsSync(settingsPath)) {
      config = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    }

    const permissions = (config.permissions || {}) as Record<string, unknown>
    const existingAsk = (permissions.ask || []) as string[]

    // Merge without duplicates
    const merged = [...new Set([...existingAsk, ...rules])]
    permissions.ask = merged
    config.permissions = permissions

    writeFileSync(settingsPath, JSON.stringify(config, null, 2) + '\n')

    const label = ['Behavioral only', 'Light guardrails', 'Moderate guardrails', 'Strict'][choice]
    console.log(`  ${c.green}✓${c.reset} ${label} configured (${rules.length} ask rules)`)
    result.configured.push(`Permission safety: ${label}`)
  } catch {
    result.warnings.push('Could not configure permission safety level')
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if Datacore is already initialized.
 */
export function isInitialized(): boolean {
  try {
    return existsSync(DATACORE_DIR) &&
      existsSync(join(DATACORE_DIR, 'agents')) &&
      readdirSync(join(DATACORE_DIR, 'agents')).length > 0 &&
      existsSync(join(DATA_DIR, '0-personal')) &&
      existsSync(join(DATA_DIR, '.git'))
  } catch {
    return false
  }
}

/**
 * Initialize a new Datacore installation.
 */
export async function initDatacore(options: InitOptions = {}): Promise<InitResult> {
  const { nonInteractive = false, skipChecks = false, stream = false, verbose = false, force = false } = options
  const answers = options.answers
  const isTTY = stream && process.stdout.isTTY

  // Answers supplied => deliberately non-interactive, and legitimately so.
  const interactive = isTTY && !nonInteractive && !answers
  const platform = detectPlatform()

  const result: InitResult = {
    success: false,
    created: [],
    configured: [],
    warnings: [],
    errors: [],
    nextSteps: [],
    spacesCreated: [],
    modulesInstalled: [],
  }

  // Without a TTY every prompt is skipped and the wizard accepts EVERY
  // default in silence — the user is never asked their name, their modules,
  // or what to call their Chief of Staff, and the run still exits 0. That is
  // precisely what an agent does when it pipes output, so the quiet path was
  // the likeliest one in practice. Taking the defaults is fine; doing it
  // without anyone choosing to is not, so it now has to be asked for.
  if (!isTTY && !options.nonInteractive && !answers) {
    result.errors.push(
      'Not a terminal, so every prompt would be skipped and all defaults taken ' +
      'silently (including naming your Chief of Staff "Winston"). Re-run in a ' +
      'terminal you can type into, pass --yes to accept the defaults ' +
      'deliberately, or supply --answers (see --print-questions) if an agent ' +
      'gathered them from you already.',
    )
    return result
  }

  const op = startOperation('init', { options })
  op.start()

  let profile: UserProfile = { name: '', email: '', useCase: 'both', role: '' }

  try {
    // ═════════════════════════════════════════════════════════════════════
    // BANNER
    // ═════════════════════════════════════════════════════════════════════
    if (isTTY) {
      console.clear()
      console.log(BANNER)
      console.log(`  ${c.dim}Setting up your AI-powered second brain...${c.reset}`)
      console.log()
      await sleep(300)
    }

    // ═════════════════════════════════════════════════════════════════════
    // STEP 1/10: ABOUT YOU
    // ═════════════════════════════════════════════════════════════════════
    op.addStep('about_you')
    op.startStep('about_you')

    if (interactive) {
      section(`Step 1/${TOTAL_STEPS}: About You`)
      console.log()
      console.log(`  ${c.dim}Let's personalize your setup. This configures your identity,${c.reset}`)
      console.log(`  ${c.dim}AI context layer, and tailors the experience to your needs.${c.reset}`)
      console.log()

      // Pre-fill from git config if available, then from the GitHub account.
      const gitConfig = isGitConfigured()
      const gh = githubIdentity()
      if (gitConfig.name) profile.name = gitConfig.name
      if (gitConfig.email) profile.email = gitConfig.email
      if (!profile.email && gh) profile.email = gh.noreply

      profile.name = await prompt(`  Your name`, profile.name || undefined)

      // Say what the address is FOR. It becomes `git config user.email`, which
      // is how GitHub decides whose commits these are -- so the right answer is
      // an address on their GitHub account, not whichever one came to mind.
      if (gh) {
        console.log()
        console.log(`  ${c.dim}Your email signs your git commits. GitHub links them to${c.reset}`)
        console.log(`  ${c.dim}your account only if the address is one it knows.${c.reset}`)
        console.log(`  ${c.dim}Signed in as ${c.reset}${gh.login}${c.dim} — the default below is that${c.reset}`)
        console.log(`  ${c.dim}account's private noreply address, which always matches.${c.reset}`)
      } else {
        console.log()
        console.log(`  ${c.dim}Your email signs your git commits. Use the address on your${c.reset}`)
        console.log(`  ${c.dim}GitHub account, or commits will not be linked to you.${c.reset}`)
      }
      profile.email = await prompt(`  Your email`, profile.email || undefined)

      console.log()
      console.log(`  ${c.bold}How will you use Datacore?${c.reset}`)
      const useCaseIdx = await choose('  Choose', [
        'Personal productivity (GTD, knowledge management, AI delegation)',
        'Team management (projects, collaboration, shared knowledge)',
        'Both personal and team use',
      ], 2)
      profile.useCase = (['personal', 'team', 'both'] as const)[useCaseIdx] ?? 'both'


      console.log()
      console.log(`  ${c.green}✓${c.reset} Welcome, ${c.bold}${profile.name || 'friend'}${c.reset}!`)
      console.log()
    } else {
      // Non-interactive: answers first, then git config. An answer the user
      // actually gave beats a value inferred from their git setup.
      const gitConfig = isGitConfigured()
      profile.name = answers?.name || gitConfig.name || profile.name
      profile.email = answers?.email || gitConfig.email || githubIdentity()?.noreply || profile.email
      if (answers?.useCase) profile.useCase = answers.useCase
    }

    op.completeStep('about_you')

    // ═════════════════════════════════════════════════════════════════════
    // STEP 2/10: SYSTEM SETUP
    // ═════════════════════════════════════════════════════════════════════
    op.addStep('system_setup')
    op.startStep('system_setup')

    if (!skipChecks) {
      if (isTTY) {
        section(`Step 2/${TOTAL_STEPS}: System Setup`)
        console.log()
        console.log(`  ${c.dim}Ensuring all tools are installed and configured.${c.reset}`)
        console.log(`  ${c.dim}Datacore will install anything that's missing.${c.reset}`)
        console.log()
      }

      // On macOS, ensure Homebrew is available first
      if (platform === 'macos') {
        if (!commandExists('brew')) {
          if (isTTY) {
            console.log(`  ${c.dim}Homebrew is needed to install system packages on macOS.${c.reset}`)
            console.log()
          }
          await ensureHomebrew(!!isTTY)
        }
      }

      // --- git ---
      const git = await ensureDependency('git', 'git', platform, !!isTTY)
      if (git.available) {
        if (!git.wasInstalled && isTTY) {
          console.log(`  ${c.green}✓${c.reset} git ${c.dim}(${git.version})${c.reset}`)
        }

        // Configure git identity from About You if not configured
        const gitConfig = isGitConfigured()
        if (!gitConfig.configured && profile.name && profile.email) {
          if (isTTY) {
            const spinner = new Spinner('Configuring git identity...')
            spinner.start()
            runArgs('git', ['config', '--global', 'user.name', profile.name])
            runArgs('git', ['config', '--global', 'user.email', profile.email])
            spinner.succeed(`Git configured as: ${profile.name} <${profile.email}>`)
          } else {
            runArgs('git', ['config', '--global', 'user.name', profile.name])
            runArgs('git', ['config', '--global', 'user.email', profile.email])
          }
        } else if (gitConfig.configured && interactive && profile.name && profile.email &&
          (gitConfig.name !== profile.name || gitConfig.email !== profile.email)) {
          console.log(`    ${c.dim}Git configured as: ${gitConfig.name} <${gitConfig.email}>${c.reset}`)
          const override = await confirm(`    Update to ${profile.name} <${profile.email}>?`, false)
          if (override) {
            runArgs('git', ['config', '--global', 'user.name', profile.name])
            runArgs('git', ['config', '--global', 'user.email', profile.email])
            console.log(`  ${c.green}✓${c.reset} Git updated to: ${profile.name} <${profile.email}>`)
          }
        } else if (gitConfig.configured && isTTY && !git.wasInstalled) {
          console.log(`    ${c.dim}Configured as: ${gitConfig.name} <${gitConfig.email}>${c.reset}`)
        }
      } else {
        result.errors.push('git is required but could not be installed')
      }

      // --- node ---
      // Node is likely already installed (user ran npm install to get this CLI)
      const node = await ensureDependency('node', 'node', platform, !!isTTY, '-v', '20.0')
      if (node.available && !node.wasInstalled && isTTY) {
        console.log(`  ${c.green}✓${c.reset} node ${c.dim}(${node.version})${c.reset}`)
      }

      // Suggest update if node is outdated
      if (node.available && node.version) {
        const major = parseInt(node.version.split('.')[0] || '0', 10)
        if (major < 20) {
          if (isTTY) console.log(`    ${c.yellow}⚠${c.reset} ${c.dim}Node ${node.version} is outdated. Consider updating to Node 20+${c.reset}`)
          result.warnings.push(`Node.js ${node.version} is outdated - recommend Node 20+`)
        }
      }

      // --- Node version ---
      // package.json says >=20 but npm does not enforce engines, so an
      // 18.x machine installs and runs to completion and only trips later on
      // whatever 20-only syntax it eventually reaches. Say it at install time.
      const nodeMajor = Number(process.versions.node.split('.')[0])
      if (nodeMajor < 20) {
        if (isTTY) {
          console.log(`  ${c.dim}! Node ${process.versions.node} is below the supported 20+.${c.reset}`)
        }
        result.warnings.push(
          `Node ${process.versions.node} is below the supported minimum (20). ` +
          'The install may complete and fail later. Upgrade with: nvm install 20',
        )
      }

      // --- Claude Code (most critical tool) ---
      const claude = await ensureDependency('claude', 'claude', platform, !!isTTY)
      if (claude.available && !claude.wasInstalled && isTTY) {
        console.log(`  ${c.green}✓${c.reset} Claude Code ${c.dim}(${claude.version})${c.reset}`)
      }
      if (!claude.available) {
        result.warnings.push('Claude Code not installed - install with: npm install -g @anthropic-ai/claude-code')
      }

      // --- Datacore MCP server ---
      const mcp = await ensureDependency('datacore-mcp', 'datacore-mcp', platform, !!isTTY)
      if (mcp.available && !mcp.wasInstalled && isTTY) {
        console.log(`  ${c.green}✓${c.reset} Datacore MCP ${c.dim}(${mcp.version})${c.reset}`)
      }
      if (!mcp.available) {
        result.warnings.push('Datacore MCP not installed - install with: npm install -g @datacore-one/mcp')
      }

      // --- PLUR MCP server (memory) ---
      // Installed unconditionally: Datacore without PLUR is an assistant that
      // forgets every correction between sessions.
      const plur = await ensureDependency('plur-mcp', 'plur-mcp', platform, !!isTTY)
      if (plur.available && !plur.wasInstalled && isTTY) {
        console.log(`  ${c.green}✓${c.reset} PLUR memory ${c.dim}(${plur.version})${c.reset}`)
      }
      if (!plur.available) {
        result.warnings.push('PLUR not installed - install with: npm install -g @plur-ai/mcp')
      }

      // --- python ---
      const python = await ensureDependency('python', 'python3', platform, !!isTTY, '--version', '3.10')
      if (python.available && !python.wasInstalled && isTTY) {
        console.log(`  ${c.green}✓${c.reset} python ${c.dim}(${python.version})${c.reset}`)
      }
      if (!python.available) {
        result.warnings.push('Python not installed - some agents may not work')
      }

      // --- GitHub CLI ---
      const gh = await ensureDependency('gh', 'gh', platform, !!isTTY)
      if (gh.available && !gh.wasInstalled && isTTY) {
        // Check if authenticated
        const ghAuth = checkGhAuth()
        if (ghAuth.available) {
          console.log(`  ${c.green}✓${c.reset} GitHub CLI ${c.dim}(authenticated as ${ghAuth.user})${c.reset}`)
        } else {
          console.log(`  ${c.green}✓${c.reset} GitHub CLI ${c.dim}(installed, not authenticated)${c.reset}`)
        }
      }

      // Authenticate gh if installed but not authenticated
      if (commandExists('gh')) {
        const ghAuth = checkGhAuth()
        if (!ghAuth.available && interactive) {
          console.log()
          console.log(`  ${c.dim}To connect your GitHub account, a browser window will open.${c.reset}`)
          const doAuth = await confirm('  Authenticate with GitHub now?', true)
          if (doAuth) {
            try {
              execFileSync('gh', ['auth', 'login', '--web', '--git-protocol', 'https'], {
                stdio: 'inherit',
                timeout: 120000,
              })
              const newAuth = checkGhAuth()
              if (newAuth.available) {
                console.log(`  ${c.green}✓${c.reset} GitHub authenticated (${newAuth.user})`)
              }
            } catch {
              console.log(`  ${c.yellow}⚠${c.reset} GitHub authentication skipped`)
              result.warnings.push('GitHub CLI not authenticated - fork workflow may not work')
            }
          } else {
            result.warnings.push('GitHub CLI not authenticated - run: gh auth login')
          }
        }
      }


      if (isTTY) {
        console.log()
        // Check if all critical deps are available
        if (git.available && node.available) {
          console.log(`  ${c.green}All systems ready.${c.reset}`)
        } else {
          console.log(`  ${c.yellow}Some tools could not be installed. Continuing with what's available.${c.reset}`)
        }
        console.log()
      }
    }

    op.completeStep('system_setup')

    // ═════════════════════════════════════════════════════════════════════
    // STEP 3/10: SETTING UP REPOSITORY
    // ═════════════════════════════════════════════════════════════════════
    op.addStep('clone_repo')
    op.startStep('clone_repo')

    if (isTTY) {
      section(`Step 3/${TOTAL_STEPS}: Setting Up Repository`)
      console.log()
      console.log(`  ${c.dim}Datacore lives in ~/Data. We'll fork the main repository to your${c.reset}`)
      console.log(`  ${c.dim}GitHub account so you can customize freely and pull updates.${c.reset}`)
      console.log()
    }

    const ghAuth = checkGhAuth()
    const upstreamUrl = `https://github.com/${UPSTREAM_REPO}.git`

    // ── Phase 1: Ensure fork exists (if gh is authenticated) ──────────
    let ghUser: string | undefined

    if (ghAuth.available) {
      ghUser = ghAuth.user || runArgsOutput('gh', ['api', 'user', '-q', '.login'], { timeout: 15000 })

      const forkSpinner = isTTY ? new Spinner('Checking fork...') : null
      forkSpinner?.start()

      // Does a repo of that name exist, AND is it a fork of ours?
      //
      // Only the first half used to be checked, and `gh repo view <user>/datacore`
      // succeeds for ANY repo with that name. So an unrelated repo called
      // "datacore" -- or one forked years ago and abandoned -- was adopted as
      // "the fork" and cloned as the user's whole installation, silently.
      // Measured 2026-09-23 on this machine: plur9/datacore is not a fork at
      // all (no parent) and was last pushed 2025-12-02. The install cloned it
      // and produced a ~10-month-old Datacore -- 9 files under .datacore/lib
      // instead of several hundred, and no .datacore/settings.json, so not one
      // Claude Code hook was configured. Everything downstream looked fine.
      const parent = runArgsOutput('gh',
        ['repo', 'view', `${ghUser}/datacore`, '--json', 'parent', '-q', '.parent.owner.login + "/" + .parent.name'],
        { timeout: 30000 })
      const forkExists = parent === UPSTREAM_REPO
      const wrongRepoInTheWay = !forkExists
        && runArgs('gh', ['repo', 'view', `${ghUser}/datacore`], { cwd: process.env.HOME, timeout: 30000 })

      if (wrongRepoInTheWay) {
        // Do not touch it, do not clone it, and do not pretend it is ours.
        forkSpinner?.fail(`${ghUser}/datacore exists but is not a fork of ${UPSTREAM_REPO}`)
        result.warnings.push(
          `${ghUser}/datacore is not a fork of ${UPSTREAM_REPO} — cloning upstream directly instead. ` +
          'Rename or delete that repo first if you want your own fork.')
        ghUser = undefined
      } else if (!forkExists) {
        forkSpinner?.update('Forking repository...')
        const forked = runArgs('gh', ['repo', 'fork', UPSTREAM_REPO, '--clone=false'], { timeout: 30000 })
        if (forked) {
          forkSpinner?.succeed(`Forked to ${ghUser}/datacore`)
        } else {
          forkSpinner?.fail('Fork failed (will clone upstream directly)')
          result.warnings.push('Could not fork repository - will clone directly')
          ghUser = undefined
        }
      } else {
        forkSpinner?.succeed(`Fork exists: ${ghUser}/datacore`)
      }
    }

    // Build ordered list of URLs to try (fork HTTPS, fork SSH, upstream HTTPS, upstream SSH)
    const cloneUrls: string[] = []
    if (ghUser) {
      cloneUrls.push(`https://github.com/${ghUser}/datacore.git`)
      cloneUrls.push(`git@github.com:${ghUser}/datacore.git`)
    }
    if (!ghAuth.available && interactive) {
      const customUrl = await prompt('  Repository URL', upstreamUrl)
      cloneUrls.push(customUrl)
      const sshUrl = customUrl.replace('https://github.com/', 'git@github.com:')
      if (sshUrl !== customUrl) cloneUrls.push(sshUrl)
    } else {
      cloneUrls.push(upstreamUrl)
      cloneUrls.push(`git@github.com:${UPSTREAM_REPO}.git`)
    }

    if (!ghAuth.available && interactive) {
      console.log(`  ${c.dim}GitHub CLI not authenticated. Cloning upstream directly.${c.reset}`)
      console.log(`  ${c.dim}You can fork later with: gh repo fork --remote${c.reset}`)
      console.log()
    }

    // ── Phase 2: Ensure ~/Data is a git repository ────────────────────
    const hasGitDir = existsSync(join(DATA_DIR, '.git'))
    // A .git dir might exist but be broken (no commits, from a failed init)
    const hasValidGit = hasGitDir && runArgs('git', ['rev-parse', 'HEAD'], { cwd: DATA_DIR, timeout: 5000 })

    if (hasValidGit) {
      // ── Case A: Working git repo → pull and verify remotes ──────────
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Found existing repository at ~/Data`)

      const pullSpinner = isTTY ? new Spinner('Pulling latest changes...') : null
      pullSpinner?.start()
      // MERGE, and NEVER --autostash (DIP-0046). This runs against an ALREADY
      // POPULATED ~/Data — someone's real work — so both halves of the old
      // flags were live hazards here. Rebase rewrites unpushed local commits;
      // --autostash keeps the stash when its pop conflicts, which is precisely
      // how conflict markers got written into org files and blocked briefing
      // delivery for three days (2026-08-03).
      //
      // A plain merge pull REFUSES when the tree is dirty rather than moving
      // the user's changes somewhere they will not think to look. Refusing is
      // the safe outcome, and the failure path below is already non-fatal.
      if (runArgs('git', ['pull', '--no-rebase'], { cwd: DATA_DIR, timeout: 60000 })) {
        pullSpinner?.succeed('Repository up to date')
      } else {
        pullSpinner?.fail('Pull failed (non-fatal, continuing)')
        result.warnings.push('Could not pull latest changes')
      }

      // Verify remotes are correct
      const currentUpstream = runArgsOutput('git', ['remote', 'get-url', 'upstream'])
      if (!currentUpstream) {
        runArgs('git', ['remote', 'add', 'upstream', upstreamUrl], { cwd: DATA_DIR })
      }
    } else {
      // ── Need to set up git ──────────────────────────────────────────
      mkdirSync(DATA_DIR, { recursive: true })

      // Try clone first (works for empty or non-existent dirs)
      const cloneSpinner = isTTY ? new Spinner('Cloning into ~/Data...') : null
      cloneSpinner?.start()

      let lastCloneErr = ''
      let cloned = false
      for (const url of cloneUrls) {
        const r = runArgsWithError('git', ['clone', url, '.'], { cwd: DATA_DIR, timeout: 300000 })
        if (r.ok) {
          cloned = true
          break
        }
        lastCloneErr = r.stderr || ''
        // If dir is not empty, clone can't work with any URL - stop trying
        if (lastCloneErr.includes('already exists and is not an empty directory')) break
      }

      if (cloned) {
        cloneSpinner?.succeed('Cloned into ~/Data')
        result.created.push(DATA_DIR)
        if (ghUser) {
          runArgs('git', ['remote', 'add', 'upstream', upstreamUrl], { cwd: DATA_DIR })
        }
      } else if (lastCloneErr.includes('already exists and is not an empty directory')) {
        // ── Case C: Directory not empty → need git init approach ──────
        // A directory holding only our own operation log is a FIRST RUN, not
        // a user's populated ~/Data. Take the git-init path without demanding
        // --force, or every fresh install fails on the state dir init itself
        // just wrote.
        const onlyOurs = containsOnlyOwnState(DATA_DIR)
        if (!force && !onlyOurs) {
          cloneSpinner?.fail('~/Data is not empty')
          const entries = readdirSync(DATA_DIR)
          if (isTTY) {
            console.log(`    ${c.dim}~/Data contains ${entries.length} items but is not a git repository.${c.reset}`)
            console.log(`    ${c.dim}Use --force to initialize git in the existing directory.${c.reset}`)
            console.log(`    ${c.dim}Or remove/rename ~/Data for a fresh install.${c.reset}`)
          }
          result.errors.push('~/Data exists and is not empty. Use --force to re-initialize.')
          op.failStep('clone_repo', 'Directory not empty')
          op.fail('~/Data is not empty')
          return result
        }

        // --force, or a first run whose only contents are ours:
        // initialize git in the existing directory
        cloneSpinner?.update('Initializing git in existing ~/Data...')

        let initOk = false
        let lastInitErr = ''
        for (const url of cloneUrls) {
          const r = initGitInDir(url, DATA_DIR)
          if (r.ok) {
            initOk = true
            break
          }
          lastInitErr = r.stderr || ''
        }

        if (initOk) {
          cloneSpinner?.succeed('Git initialized in existing ~/Data')
          if (ghUser) {
            runArgs('git', ['remote', 'add', 'upstream', upstreamUrl], { cwd: DATA_DIR })
          }
        } else {
          cloneSpinner?.fail('Could not initialize git')
          // "cannot run ssh: No such file or directory" is what an offline
          // machine actually reports, and it sends people hunting for an ssh
          // problem they do not have. Name the likely cause instead of
          // forwarding git's wording unedited.
          const offline = /cannot run ssh|could not resolve host|network is unreachable|temporary failure in name resolution|connection timed out/i
            .test(lastInitErr)
          result.errors.push(
            offline
              ? `Could not reach GitHub — check the network (and that ssh is installed). Underlying error: ${lastInitErr.trim().split('\n')[0]}`
              : `Git init failed: ${lastInitErr}`,
          )
          if (lastInitErr.includes('Authentication') || lastInitErr.includes('403') || lastInitErr.includes('401')) {
            if (isTTY) console.log(`    ${c.dim}Check your GitHub access: gh auth status${c.reset}`)
          }
          op.failStep('clone_repo', 'Git init failed')
          op.fail('Git init failed')
          return result
        }
      } else {
        // ── Clone failed for other reasons (auth, repo not found, etc.)
        cloneSpinner?.fail('Clone failed')
        if (lastCloneErr.includes('not found') || lastCloneErr.includes('not exist') || lastCloneErr.includes('does not appear to be a git repository')) {
          result.errors.push('Repository not found')
          if (isTTY) {
            if (ghUser) {
              console.log(`    ${c.dim}Neither ${ghUser}/datacore nor ${UPSTREAM_REPO} could be cloned.${c.reset}`)
            }
            console.log(`    ${c.dim}Ensure you have access to ${UPSTREAM_REPO} and try again.${c.reset}`)
            console.log(`    ${c.dim}Check access: gh repo view ${UPSTREAM_REPO}${c.reset}`)
          }
        } else if (lastCloneErr.includes('Authentication') || lastCloneErr.includes('Permission') || lastCloneErr.includes('403') || lastCloneErr.includes('401')) {
          result.errors.push('Authentication failed')
          if (isTTY) {
            console.log(`    ${c.dim}Could not authenticate with GitHub.${c.reset}`)
            console.log(`    ${c.dim}Try: gh auth login${c.reset}`)
          }
        } else {
          result.errors.push(`Clone failed: ${lastCloneErr}`)
        }
        op.failStep('clone_repo', 'Clone failed')
        op.fail('Clone failed')
        return result
      }
    }

    // Clone DIPs repo (tracked as gitlink, not auto-cloned)
    const dipsDir = join(DATACORE_DIR, 'dips')
    if (existsSync(DATACORE_DIR) && !existsSync(join(dipsDir, '.git'))) {
      const spinner = isTTY ? new Spinner('Fetching specifications...') : null
      spinner?.start()

      const dipsRepo = 'https://github.com/datacore-one/datacore-dips.git'
      let clonedDips = runArgs('git', ['clone', dipsRepo, dipsDir], { timeout: 300000 })
      if (!clonedDips) {
        clonedDips = runArgs('git', ['clone', 'git@github.com:datacore-one/datacore-dips.git', dipsDir], { timeout: 300000 })
      }

      if (clonedDips) {
        spinner?.succeed('Specifications installed')
      } else {
        spinner?.fail('Could not fetch specifications (non-fatal)')
        result.warnings.push('Specifications repo not cloned')
      }
    } else if (existsSync(join(dipsDir, '.git'))) {
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Specifications present`)
    }

    if (isTTY) console.log()
    // ── Safety hooks ────────────────────────────────────────────────────
    // `core.hooksPath` was never set by the installer, so every guard in
    // .datacore/githooks/ — the secret scan, the wrong-weekday check, the
    // conflict-marker check — existed in the repo and ran on nobody's machine
    // but the author's. Two of those three caught real, pre-existing defects
    // while preparing modules for release on 2026-09-21.
    const hooksDir = join(DATA_DIR, '.datacore', 'githooks')
    if (existsSync(hooksDir) && existsSync(join(DATA_DIR, '.git'))) {
      if (runArgs('git', ['config', 'core.hooksPath', '.datacore/githooks'], { cwd: DATA_DIR })) {
        if (isTTY) console.log(`  ${c.green}✓${c.reset} safety hooks enabled ${c.dim}(core.hooksPath)${c.reset}`)
        result.configured.push('Git safety hooks')
      } else {
        result.warnings.push('Could not set core.hooksPath - commit guards are inactive')
      }
    }

    localiseHookPaths(isTTY, result)

    op.completeStep('clone_repo')

    // ═════════════════════════════════════════════════════════════════════
    // STEP 4/10: TEAM SPACES
    // ═════════════════════════════════════════════════════════════════════
    op.addStep('team_spaces')
    op.startStep('team_spaces')

    if (interactive) {
      section(`Step 4/${TOTAL_STEPS}: Team Spaces`)
      console.log()
      console.log(`  ${c.dim}Spaces separate different areas of your life. Your personal space${c.reset}`)
      console.log(`  ${c.dim}(0-personal) is created automatically. Team spaces are separate${c.reset}`)
      console.log(`  ${c.dim}git repos for organizations you work with.${c.reset}`)
      console.log()

      if (profile.useCase === 'personal') {
        console.log(`  ${c.dim}You selected personal use. You can add team spaces anytime later:${c.reset}`)
        console.log(`    ${c.dim}datacore space create <name>${c.reset}`)
      } else {
        console.log(`  ${c.dim}Each team space gets its own:${c.reset}`)
        console.log(`    ${c.dim}• GTD task system and AI agents${c.reset}`)
        console.log(`    ${c.dim}• Knowledge base (wiki, notes, research)${c.reset}`)
        console.log(`    ${c.dim}• Project tracking via GitHub Issues${c.reset}`)
        console.log()

        // Show existing spaces
        const existingSpaces = listSpaces()
        const existingNames = existingSpaces.map(s => s.name.replace(/^\d+-/, ''))

        if (existingSpaces.length > 1) {
          console.log(`  ${c.dim}Existing spaces:${c.reset}`)
          for (const s of existingSpaces) {
            console.log(`    ${s.type === 'personal' ? '👤' : '👥'} ${s.name}`)
          }
          console.log()
        }

        const wantSpace = await confirm('  Would you like to add a team space?', false)

        if (wantSpace) {
          let adding = true
          while (adding) {
            const spaceName = await prompt('  Space name (e.g., "datafund", "acme-corp")')
            if (!spaceName) {
              adding = false
              continue
            }

            const normalized = spaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')

            // Search known spaces registry
            const knownMatch = KNOWN_SPACES.find(ks =>
              ks.name === normalized ||
              ks.displayName.toLowerCase() === spaceName.toLowerCase() ||
              (normalized.length >= 3 && ks.name.startsWith(normalized)) ||
              (normalized.length >= 3 && ks.displayName.toLowerCase().startsWith(normalized.toLowerCase()))
            )

            // Check if already installed
            if (existingNames.includes(normalized) || existingNames.includes(knownMatch?.name ?? '')) {
              console.log(`  ${c.green}✓${c.reset} ${spaceName} is already installed`)
              adding = await confirm('  Add another?', false)
              continue
            }

            if (knownMatch) {
              // Found in registry - clone directly
              console.log(`  ${c.green}✓${c.reset} Found registered space: ${c.bold}${knownMatch.displayName}${c.reset}`)
              console.log(`    ${c.dim}${knownMatch.description}${c.reset}`)

              const currentSpaces = listSpaces()
              const nextNum = currentSpaces.length > 0
                ? Math.max(...currentSpaces.map(s => s.number)) + 1
                : 1
              const spacePath = join(DATA_DIR, `${nextNum}-${knownMatch.name}`)

              const spinner = new Spinner(`Cloning ${knownMatch.displayName}...`)
              spinner.start()

              // Try HTTPS first, fall back to SSH (needed for private repos)
              let cloned = runArgs('git', ['clone', knownMatch.repo, spacePath], { timeout: 300000 })
              if (!cloned) {
                const sshUrl = knownMatch.repo.replace('https://github.com/', 'git@github.com:')
                cloned = runArgs('git', ['clone', sshUrl, spacePath], { timeout: 300000 })
              }

              if (cloned) {
                spinner.succeed(`Added space: ${nextNum}-${knownMatch.name}`)
                result.spacesCreated.push(`${nextNum}-${knownMatch.name}`)
              } else {
                spinner.fail(`Could not clone ${knownMatch.displayName}`)
                if (knownMatch.private) {
                  console.log(`    ${c.dim}This is a private repo. Make sure you have access to ${knownMatch.org}.${c.reset}`)
                  console.log(`    ${c.dim}Request access or try: gh auth refresh -s read:org${c.reset}`)
                }
                result.warnings.push(`Failed to add space: ${knownMatch.name}`)
              }
            } else {
              // Not in registry — join an existing one, or make a new one.
              const repoUrl = await prompt('  Git repo URL to join (or Enter to create a new space)', '')
              const {
                createSpace, initSpaceGit, joinSpace, detectForges, createSpaceRemote,
              } = await import('./space')

              if (repoUrl) {
                // joinSpace owns the numbering, the SSH fallback and the
                // is-this-actually-a-space check. This branch used to carry its
                // own copy of the first two and neither of the others.
                const spinner = new Spinner(`Cloning ${spaceName}...`)
                spinner.start()
                try {
                  const { space, warnings } = joinSpace(repoUrl, { name: normalized })
                  spinner.succeed(`Joined space: ${space.name}`)
                  result.spacesCreated.push(space.name)
                  for (const w of warnings) {
                    console.log(`    ${c.dim}${w}${c.reset}`)
                    result.warnings.push(w)
                  }
                } catch (err) {
                  spinner.fail((err as Error).message)
                  result.warnings.push(`Failed to join space: ${spaceName}`)
                }
              } else {
                try {
                  const space = createSpace(spaceName, 'team')
                  result.created.push(space.path)
                  result.spacesCreated.push(space.name)
                  console.log(`  ${c.green}✓${c.reset} Created ${space.name}/`)

                  // A space is a git repo, and a team space with no remote is
                  // a team space only this machine can see. Ask now, while the
                  // context is obvious, rather than leaving it to be discovered
                  // the first time someone else needs the space.
                  const git = initSpaceGit(space.path)
                  if (!git.ok) {
                    console.log(`    ${c.yellow}!${c.reset} ${c.dim}Not a git repo yet: ${git.error}${c.reset}`)
                  } else {
                    const forges = detectForges()
                    const labels = [
                      ...forges.map(f => f.available
                        ? `${f.label}${f.account ? ` (signed in as ${f.account})` : ''}`
                        : `${f.label} — unavailable: ${f.reason}`),
                      'Other host — paste a repo URL',
                      'Local only — decide later',
                    ]
                    console.log()
                    console.log(`    ${c.dim}A team space is a git repo others clone. Where should it live?${c.reset}`)
                    const pick = await choose('    Choose', labels, labels.length - 1)

                    let remoteResult
                    if (pick < forges.length && forges[pick]!.available) {
                      const spin = new Spinner(`Creating ${forges[pick]!.label} repo...`)
                      spin.start()
                      remoteResult = createSpaceRemote(space.path, space.name.replace(/^\d+-/, ''), {
                        forge: forges[pick]!.id, visibility: 'private',
                      })
                      remoteResult.ok
                        ? spin.succeed(`Remote: ${remoteResult.url ?? 'origin set'}`)
                        : spin.fail(remoteResult.error || 'could not create the repo')
                    } else if (pick < forges.length) {
                      console.log(`    ${c.dim}${forges[pick]!.reason} — left local.${c.reset}`)
                    } else if (pick === forges.length) {
                      const url = await prompt('    Repo URL (create the empty repo on your host first)')
                      if (url) {
                        const spin = new Spinner('Pushing...')
                        spin.start()
                        remoteResult = createSpaceRemote(space.path, space.name, { url })
                        remoteResult.ok && remoteResult.pushed
                          ? spin.succeed(`Pushed to ${url}`)
                          : spin.fail(remoteResult.error || 'push failed')
                      }
                    }
                    if (remoteResult && !remoteResult.ok) {
                      result.warnings.push(`No remote for ${space.name}: ${remoteResult.error}`)
                    }
                  }
                } catch (err) {
                  console.log(`  ${c.red}✗${c.reset} ${(err as Error).message}`)
                }
              }
            }

            adding = await confirm('  Add another?', false)
          }
        }
      }
      console.log()
    }

    op.completeStep('team_spaces')

    // ═════════════════════════════════════════════════════════════════════
    // STEP 5/10: YOUR SECOND BRAIN
    // ═════════════════════════════════════════════════════════════════════
    op.addStep('second_brain')
    op.startStep('second_brain')

    if (isTTY) {
      section(`Step 5/${TOTAL_STEPS}: Your Second Brain`)
      console.log()
      console.log(`  ${c.dim}Your personal space is your AI-powered second brain. Here's how${c.reset}`)
      console.log(`  ${c.dim}it's organized:${c.reset}`)
      console.log()

      // GTD education
      console.log(`  ${c.bold}Getting Things Done (GTD)${c.reset}`)
      console.log(`  ${c.dim}A trusted system where you capture everything into an inbox, then${c.reset}`)
      console.log(`  ${c.dim}process it into actionable next steps. Nothing stays in your head.${c.reset}`)
      console.log(`    ${c.dim}• org/inbox.org         → Capture anything, anytime${c.reset}`)
      console.log(`    ${c.dim}• org/next_actions.org  → What you're actually doing${c.reset}`)
      console.log(`    ${c.dim}• org/someday.org       → Ideas for later${c.reset}`)
      console.log()

      // AI delegation education
      console.log(`  ${c.bold}AI Delegation${c.reset}`)
      console.log(`  ${c.dim}Tag tasks with :AI: and agents handle them overnight:${c.reset}`)
      console.log(`    ${c.dim}• :AI:research:  → Deep research on any topic${c.reset}`)
      console.log(`    ${c.dim}• :AI:content:   → Draft emails, blog posts, docs${c.reset}`)
      console.log(`    ${c.dim}• :AI:data:      → Analyze data, generate reports${c.reset}`)
      console.log(`    ${c.dim}• :AI:pm:        → Track projects, flag blockers${c.reset}`)
      console.log()

      // Knowledge management education
      console.log(`  ${c.bold}Knowledge Management${c.reset}`)
      console.log(`  ${c.dim}Your knowledge compounds over time. Every note, insight, and${c.reset}`)
      console.log(`  ${c.dim}conversation gets woven into a personal knowledge base:${c.reset}`)
      console.log(`    ${c.dim}• notes/          → Daily journals, quick captures${c.reset}`)
      console.log(`    ${c.dim}• 3-knowledge/    → Permanent knowledge (Zettelkasten)${c.reset}`)
      console.log(`      ${c.dim}├── zettel/     → Atomic ideas, one concept per note${c.reset}`)
      console.log(`      ${c.dim}├── pages/      → Longer topic pages and guides${c.reset}`)
      console.log(`      ${c.dim}├── literature/ → Summaries of things you've read${c.reset}`)
      console.log(`      ${c.dim}└── reference/  → People, companies, glossary${c.reset}`)
      console.log()
      console.log(`  ${c.dim}The more you capture, the smarter your system becomes. Agents${c.reset}`)
      console.log(`  ${c.dim}cross-reference your knowledge to give better answers over time.${c.reset}`)
      console.log()
    }

    // Verify personal space exists
    const personalPath = join(DATA_DIR, '0-personal')
    if (existsSync(personalPath)) {
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Personal space ready (0-personal/)`)
      result.spacesCreated.push('0-personal')
    } else {
      // Create personal space
      if (isTTY) console.log(`  ${c.dim}Creating personal space...${c.reset}`)
      try {
        const { createSpace } = await import('./space')
        const space = createSpace('personal', 'personal')
        result.created.push(space.path)
        result.spacesCreated.push('0-personal')
        if (isTTY) console.log(`  ${c.green}✓${c.reset} Personal space created (0-personal/)`)
      } catch {
        // Space creation might fail if partially exists
        const dirs = ['org', 'notes', 'notes/journals', 'notes/pages', 'journal', '3-knowledge', 'content', '0-inbox']
        for (const dir of dirs) {
          mkdirSync(join(personalPath, dir), { recursive: true })
        }
        result.created.push(personalPath)
        result.spacesCreated.push('0-personal')
        if (isTTY) console.log(`  ${c.green}✓${c.reset} Personal space initialized`)
      }
    }

    // Verify GTD files exist
    const gtdFiles = ['inbox.org', 'next_actions.org', 'someday.org']
    const orgDir = join(personalPath, 'org')
    let gtdReady = true
    for (const file of gtdFiles) {
      if (!existsSync(join(orgDir, file))) gtdReady = false
    }
    if (gtdReady) {
      if (isTTY) console.log(`  ${c.green}✓${c.reset} GTD system initialized`)
    }

    // Check knowledge dirs
    if (existsSync(join(personalPath, '3-knowledge'))) {
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Knowledge base ready`)
    }

    // Activate templates (.example files → real files)
    const templates: Array<{ src: string; dst: string; label: string }> = [
      { src: 'install.yaml.example', dst: 'install.yaml', label: 'Installation manifest' },
      { src: '0-personal/org/inbox.org.example', dst: '0-personal/org/inbox.org', label: 'GTD inbox' },
      { src: '0-personal/org/next_actions.org.example', dst: '0-personal/org/next_actions.org', label: 'GTD next actions' },
      { src: '0-personal/org/someday.org.example', dst: '0-personal/org/someday.org', label: 'GTD someday' },
      { src: '0-personal/org/habits.org.example', dst: '0-personal/org/habits.org', label: 'GTD habits' },
    ]

    for (const { src, dst } of templates) {
      const srcPath = join(DATA_DIR, src)
      const dstPath = join(DATA_DIR, dst)
      if (existsSync(srcPath) && !existsSync(dstPath)) {
        copyFileSync(srcPath, dstPath)
        result.created.push(dstPath)
      }
    }
    if (isTTY) console.log(`  ${c.green}✓${c.reset} Templates activated`)

    // Create CLAUDE.local.md (private context layer)
    const claudeLocalPath = join(DATA_DIR, 'CLAUDE.local.md')
    if (!existsSync(claudeLocalPath)) {
      const localContent = [
        `<!-- PRIVATE LAYER - This file is gitignored and never shared -->`,
        ``,
        `# ${profile.name || 'My'}'s Datacore`,
        ``,
        ``,
        `## My Workflow`,
        ``,
        `<!-- Add your personal workflow notes, preferences, and shortcuts here. -->`,
        `<!-- This file is gitignored and only visible to your local Claude Code. -->`,
        ``,
        `## Custom Context`,
        ``,
        `<!-- Any private context that helps Claude assist you better: -->`,
        `<!-- - Project abbreviations and shorthand -->`,
        `<!-- - Personal communication preferences -->`,
        `<!-- - Domain expertise and background -->`,
        ``,
      ].filter(Boolean).join('\n')

      writeFileSync(claudeLocalPath, localContent)
      result.created.push(claudeLocalPath)
      if (isTTY) console.log(`  ${c.green}✓${c.reset} CLAUDE.local.md created (your private AI context)`)
    }

    // Create settings.local.yaml
    const settingsLocalPath = join(DATACORE_DIR, 'settings.local.yaml')
    if (existsSync(DATACORE_DIR) && !existsSync(settingsLocalPath)) {
      const settingsContent = [
        `# Personal Settings Overrides (gitignored)`,
        `# See settings.yaml for all available options`,
        ``,
        `editor:`,
        `  open_markdown_on_generate: false`,
        ``,
        `sync:`,
        `  pull_on_today: true`,
        `  push_on_wrap_up: true`,
        ``,
      ].join('\n')

      writeFileSync(settingsLocalPath, settingsContent)
      result.created.push(settingsLocalPath)
      if (isTTY) console.log(`  ${c.green}✓${c.reset} settings.local.yaml created (your preferences)`)
    }

    if (isTTY) console.log()
    op.completeStep('second_brain')

    // ═════════════════════════════════════════════════════════════════════
    // STEP 6/10: MODULES
    // ═════════════════════════════════════════════════════════════════════
    op.addStep('modules')
    op.startStep('modules')

    if (isTTY) {
      section(`Step 6/${TOTAL_STEPS}: Modules`)
      console.log()
      console.log(`  ${c.dim}Modules extend Datacore with specialized capabilities. Each adds${c.reset}`)
      console.log(`  ${c.dim}new AI agents and /commands you can use in Claude Code.${c.reset}`)
      console.log()
    }

    // Ensure modules directory exists
    const modulesDir = join(DATACORE_DIR, 'modules')
    if (existsSync(DATACORE_DIR)) {
      mkdirSync(modulesDir, { recursive: true })
    }

    const installedNames = listModules().map(m => m.name)
    const allModules = AVAILABLE_MODULES

    // Determine which modules to install
    let modulesToInstall: typeof AVAILABLE_MODULES = []

    if (interactive) {
      // Show all modules with checkboxes, all selected by default
      console.log(`  ${c.dim}All modules are selected by default. Deselect any you don't need:${c.reset}`)
      console.log()

      const selected = new Set(allModules.map((_, i) => i))

      for (let i = 0; i < allModules.length; i++) {
        const mod = allModules[i]!
        const isInstalled = installedNames.includes(mod.name)
        const coreLabel = mod.core ? ` ${c.dim}(core)${c.reset}` : ''
        const installedLabel = isInstalled ? ` ${c.dim}(installed)${c.reset}` : ''
        const num = String(i + 1).padStart(2, ' ')
        console.log(`  [x] ${c.cyan}${num}${c.reset}. ${c.bold}${mod.name.padEnd(12)}${c.reset} ${mod.description}${coreLabel}${installedLabel}`)
      }
      console.log()

      const removeInput = await prompt('  Enter numbers to REMOVE, or press Enter to install all', '')

      if (removeInput) {
        const nums = removeInput.split(/[,\s]+/).map(s => parseInt(s.trim(), 10))
        for (const n of nums) {
          if (n >= 1 && n <= allModules.length) {
            const mod = allModules[n - 1]!
            // Don't allow deselecting core modules
            if (!mod.core) {
              selected.delete(n - 1)
            }
          }
        }
      }

      modulesToInstall = allModules.filter((_, i) => selected.has(i))
    } else if (answers?.modules) {
      // Exactly what was asked for, by name. An unknown name is a typo worth
      // reporting, not a module to silently skip.
      const wanted = new Set(answers.modules)
      modulesToInstall = allModules.filter((m) => wanted.has(m.name))
      const unknown = [...wanted].filter((n) => !allModules.some((m) => m.name === n))
      if (unknown.length) {
        result.warnings.push(`Unknown module(s) requested: ${unknown.join(', ')}`)
      }
    } else {
      // Non-interactive with no list: every module the user can actually clone.
      // Installing the private ones produced a red error line per module on
      // every external install, for repos they were never going to reach.
      modulesToInstall = allModules.filter((m) => !m.private)
    }

    // Python dependencies go into .datacore/venv before any module needs them.
    const venv = ensureDatacoreVenv(DATA_DIR)
    result.warnings.push(...venv.warnings)
    if (!venv.python) result.errors.push('Core Python dependencies are not installed; the MCP server cannot start. Fix: datacore update')

    // Install selected modules
    let installCount = 0
    for (const mod of modulesToInstall) {
      if (installedNames.includes(mod.name)) {
        installCount++
        continue
      }

      const spinner = isTTY ? new Spinner(`Installing ${mod.name}...`) : null
      spinner?.start()

      try {
        await sleep(100)
        const info = installModule(mod.repo)
        result.modulesInstalled.push(mod.name)
        installCount++

        // Run post-install dependencies
        const postInstall = runModulePostInstall(info.path)
        if (postInstall.ran && postInstall.success) {
          spinner?.succeed(`${mod.name} - dependencies installed (${postInstall.type})`)
        } else if (postInstall.ran && !postInstall.success) {
          spinner?.succeed(`${mod.name}`)
          if (isTTY) console.log(`    ${c.yellow}⚠${c.reset} ${c.dim}Dependency install failed (${postInstall.type})${c.reset}`)
          // Into the result too: a printed-only warning left the JSON saying
          // success with no warnings while four modules had no dependencies.
          result.warnings.push(`${mod.name}: ${postInstall.type} dependencies failed to install`)
        } else {
          spinner?.succeed(mod.name)
        }
      } catch (err) {
        spinner?.fail(`${mod.name} - ${(err as Error).message}`)
        result.warnings.push(`Module ${mod.name} failed to install: ${(err as Error).message}`)
      }
    }

    if (isTTY) {
      console.log()
      console.log(`  ${c.green}${installCount} modules installed.${c.reset}`)
      console.log()
    }

    // Module tools import @datacore-one/mcp/runtime from .datacore/modules/node_modules.
    result.warnings.push(...ensureModuleDeps(DATA_DIR))

    op.completeStep('modules')

    // ═════════════════════════════════════════════════════════════════════
    // STEP 7/10: CHIEF OF STAFF
    // ═════════════════════════════════════════════════════════════════════
    op.addStep('chief_of_staff')
    op.startStep('chief_of_staff')

    if (isTTY) {
      section(`Step 7/${TOTAL_STEPS}: Your Chief of Staff`)
      console.log()
      console.log(`  Your Chief of Staff runs your day: the morning briefing, the`)
      console.log(`  evening review, triage. It acts only through approvals \u2014 nothing`)
      console.log(`  side-effecting happens without your decision.`)
      console.log()
    }

    await configureChiefOfStaff(isTTY, result, answers)
    op.completeStep('chief_of_staff')

    // ═════════════════════════════════════════════════════════════════════
    // STEP 8/10: FINALIZE
    // ═════════════════════════════════════════════════════════════════════
    op.addStep('finalize')
    op.startStep('finalize')

    if (isTTY) {
      section(`Step 8/${TOTAL_STEPS}: Finalize`)
      console.log()
    }

    // Build CLAUDE.md from layers
    const contextMerge = join(DATACORE_DIR, 'lib', 'context_merge.py')
    if (existsSync(contextMerge)) {
      const spinner = isTTY ? new Spinner('Building CLAUDE.md from layers...') : null
      spinner?.start()

      if (runArgs('python3', [contextMerge, 'rebuild', '--path', DATA_DIR, '--all'])) {
        spinner?.succeed('CLAUDE.md built from layers (all spaces)')
      } else {
        spinner?.fail('CLAUDE.md build failed (can rebuild later)')
        result.warnings.push('Could not build CLAUDE.md')
      }
    }

    // Initialize knowledge database
    const zettelDb = join(DATACORE_DIR, 'lib', 'zettel_db.py')
    if (existsSync(zettelDb)) {
      const spinner = isTTY ? new Spinner('Initializing knowledge database...') : null
      spinner?.start()

      if (runArgs('python3', [zettelDb, 'init-all'], { cwd: DATA_DIR })) {
        spinner?.succeed('Knowledge database initialized')
      } else {
        spinner?.fail('Database init failed (non-fatal)')
        result.warnings.push('Database initialization failed')
      }
    }

    // Create persistent directories
    if (existsSync(DATACORE_DIR)) {
      const stateDir = join(DATACORE_DIR, 'state')
      const envDir = join(DATACORE_DIR, 'env')
      mkdirSync(stateDir, { recursive: true })
      mkdirSync(envDir, { recursive: true })
      if (!existsSync(join(stateDir, '.gitkeep'))) writeFileSync(join(stateDir, '.gitkeep'), '')
      if (!existsSync(join(envDir, '.gitkeep'))) writeFileSync(join(envDir, '.gitkeep'), '')
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Runtime directories ready`)
    }

    // Create .claude -> .datacore symlink
    const claudeDir = join(DATA_DIR, '.claude')
    if (!existsSync(claudeDir) && existsSync(DATACORE_DIR)) {
      try {
        symlinkSync(DATACORE_DIR, claudeDir)
        result.created.push(claudeDir)
      } catch {
        // Ignore
      }
    }

    // Make sync script executable
    const syncScript = join(DATA_DIR, 'sync')
    if (existsSync(syncScript)) {
      if (platform !== 'windows') {
        runArgs('chmod', ['+x', syncScript])
      }
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Sync script configured`)
    }

    // Populate install.yaml
    const installYaml = join(DATA_DIR, 'install.yaml')
    if (existsSync(installYaml) || existsSync(DATACORE_DIR)) {
      try {
        const allSpaces = listSpaces()
        const allInstalledModules = listModules()

        const spacesYaml = allSpaces
          .filter(s => s.type !== 'personal')
          .map(s => `  ${s.name}:\n    path: ${s.name}`)
          .join('\n')

        const modulesYaml = allInstalledModules
          .map(m => `  - ${m.name}`)
          .join('\n')

        const yamlContent = [
          `# Datacore Installation Manifest`,
          `# Generated by: datacore init`,
          `# Date: ${new Date().toISOString().split('T')[0]}`,
          ``,
          `meta:`,
          `  name: "${profile.name ? `${profile.name}'s Datacore` : 'My Datacore'}"`,
          `  root: "${DATA_DIR}"`,
          `  version: 1.0.0`,
          `  use_case: ${profile.useCase}`,
          ``,
          `modules:`,
          modulesYaml || '  []',
          ``,
          `personal:`,
          `  path: 0-personal`,
          ``,
          `spaces:`,
          spacesYaml || '  {}',
          ``,
        ].filter(line => line !== null).join('\n')

        writeFileSync(installYaml, yamlContent)
        if (isTTY) console.log(`  ${c.green}✓${c.reset} install.yaml saved`)
      } catch {
        result.warnings.push('Could not update install.yaml')
      }
    }

    // Create snapshot
    try {
      const snapshot = createSnapshot()
      saveSnapshot(snapshot)
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Snapshot created (datacore.lock.yaml)`)
    } catch {
      result.warnings.push('Could not create snapshot')
    }

    // Configure MCP server for Claude Desktop and Claude Code
    configureMcpServer(isTTY, result)

    // Configure permission safety level
    if (interactive) {
      await configurePermissionPreference(result)
    }

    if (isTTY) console.log()
    op.completeStep('finalize')

    // ═════════════════════════════════════════════════════════════════════
    // STEP 9/10: IMPORT YOUR DATA
    // ═════════════════════════════════════════════════════════════════════
    op.addStep('import_data')
    op.startStep('import_data')

    const backgroundJobs: BackgroundJob[] = []
    const canBackgroundIngest = commandExists('datacore') && commandExists('claude')

    if (interactive) {
      section(`Step 9/${TOTAL_STEPS}: Import Your Data`)
      console.log()
      console.log(`  ${c.dim}Your second brain works best when it has your existing knowledge.${c.reset}`)
      console.log(`  ${c.dim}You can import data now or do it later with 'datacore ingest'.${c.reset}`)
      console.log()

      let importing = true
      let totalImported = 0
      const inboxDir = join(DATA_DIR, '0-personal', '0-inbox')
      mkdirSync(inboxDir, { recursive: true })

      const IMPORT_SKIP = 4
      while (importing) {
        console.log(`  ${c.dim}Common sources to import:${c.reset}`)
        console.log(`    ${c.cyan}1${c.reset}) ChatGPT conversation exports (JSON)`)
        console.log(`    ${c.cyan}2${c.reset}) Documents folder (PDFs, Word docs, markdown)`)
        console.log(`    ${c.cyan}3${c.reset}) Existing notes (Obsidian, Notion export, etc.)`)
        console.log(`    ${c.cyan}4${c.reset}) Skip for now`)
        console.log()

        const choice = await prompt('  What would you like to import?', '4')
        const choiceNum = parseInt(choice, 10)

        if (choiceNum === IMPORT_SKIP || !choice) {
          if (totalImported === 0) {
            console.log()
            console.log(`  ${c.dim}No problem! You can import data anytime:${c.reset}`)
            console.log(`    ${c.dim}datacore ingest ~/path/to/files${c.reset}`)
            console.log(`    ${c.dim}datacore ingest ~/Downloads/chatgpt-export.json${c.reset}`)
          }
          importing = false
          continue
        }

        if (choiceNum === 1) {
          // ChatGPT export
          const chatPath = await prompt('  Path to ChatGPT export')
          const chatResolved = chatPath?.startsWith('~') ? join(process.env.HOME || '', chatPath.slice(1)) : chatPath
          if (chatResolved && existsSync(chatResolved)) {
            const resolvedPath = chatResolved

            const spinner = new Spinner('Processing ChatGPT export...')
            spinner.start()

            try {
              const content = readFileSync(resolvedPath, 'utf-8')
              const data = JSON.parse(content)
              const count = Array.isArray(data) ? data.length : 1

              // Copy to inbox for processing
              const destName = `chatgpt-export-${Date.now()}.json`
              const destPath = join(inboxDir, destName)
              copyFileSync(resolvedPath, destPath)

              if (canBackgroundIngest) {
                const job = spawnBackground('datacore', ['ingest', destPath], 'ingest')
                if (job) {
                  backgroundJobs.push(job)
                  const bgOp = startOperation('background-ingest', { pid: job.pid, logFile: job.logFile, path: destPath })
                  bgOp.start()
                  spinner.succeed(`Found ${count} conversations - queued for background processing`)
                } else {
                  spinner.succeed(`Found ${count} conversations - copied to inbox`)
                  console.log(`    ${c.dim}Process with: datacore ingest ${destPath}${c.reset}`)
                }
              } else {
                spinner.succeed(`Found ${count} conversations - copied to inbox`)
                console.log(`    ${c.dim}Process with /ingest in Claude Code for full knowledge extraction${c.reset}`)
              }
              totalImported += count
            } catch {
              spinner.fail('Could not parse ChatGPT export')
              // Still copy the file and attempt background ingest
              try {
                const fallbackDest = join(inboxDir, basename(resolvedPath))
                copyFileSync(resolvedPath, fallbackDest)
                if (canBackgroundIngest) {
                  const job = spawnBackground('datacore', ['ingest', fallbackDest], 'ingest')
                  if (job) {
                    backgroundJobs.push(job)
                    const bgOp = startOperation('background-ingest', { pid: job.pid, logFile: job.logFile, path: fallbackDest })
                    bgOp.start()
                    console.log(`    ${c.dim}File queued for background processing${c.reset}`)
                  } else {
                    console.log(`    ${c.dim}File copied to inbox for later processing${c.reset}`)
                  }
                } else {
                  console.log(`    ${c.dim}File copied to inbox for later processing${c.reset}`)
                }
              } catch {
                // Ignore
              }
            }
          } else {
            console.log(`  ${c.yellow}⚠${c.reset} File not found: ${chatPath}`)
          }
        } else if (choiceNum === 2 || choiceNum === 3) {
          // Documents or notes
          const label = choiceNum === 2 ? 'documents' : 'notes'
          const sourcePath = await prompt(`  Path to ${label}`)
          if (sourcePath) {
            const resolvedPath = sourcePath.startsWith('~') ? join(process.env.HOME || '', sourcePath.slice(1)) : sourcePath
            if (existsSync(resolvedPath)) {
              const spinner = new Spinner(`Scanning ${resolvedPath}...`)
              spinner.start()

              const stats = statSync(resolvedPath)
              if (stats.isDirectory()) {
                const { total, byExt } = countFiles(resolvedPath)
                const extSummary = Object.entries(byExt)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 4)
                  .map(([ext, count]) => `${count} .${ext}`)
                  .join(', ')

                spinner.succeed(`Found ${total} files (${extSummary})`)

                // Copy directory to inbox
                const destDir = join(inboxDir, basename(resolvedPath))
                const copySpinner = new Spinner('Copying to inbox...')
                copySpinner.start()

                try {
                  cpSync(resolvedPath, destDir, { recursive: true })
                  if (canBackgroundIngest) {
                    const job = spawnBackground('datacore', ['ingest', destDir], 'ingest')
                    if (job) {
                      backgroundJobs.push(job)
                      const bgOp = startOperation('background-ingest', { pid: job.pid, logFile: job.logFile, path: destDir })
                      bgOp.start()
                      copySpinner.succeed(`${total} files queued for background processing`)
                    } else {
                      copySpinner.succeed(`${total} files copied to inbox`)
                      console.log(`    ${c.dim}Process with: datacore ingest ${destDir}${c.reset}`)
                    }
                  } else {
                    copySpinner.succeed(`${total} files copied to inbox`)
                    console.log(`    ${c.dim}Process with /ingest in Claude Code for full knowledge extraction${c.reset}`)
                  }
                  totalImported += total
                } catch {
                  copySpinner.fail('Copy failed')
                }
              } else {
                // Single file
                const singleDest = join(inboxDir, basename(resolvedPath))
                copyFileSync(resolvedPath, singleDest)
                if (canBackgroundIngest) {
                  const job = spawnBackground('datacore', ['ingest', singleDest], 'ingest')
                  if (job) {
                    backgroundJobs.push(job)
                    const bgOp = startOperation('background-ingest', { pid: job.pid, logFile: job.logFile, path: singleDest })
                    bgOp.start()
                    spinner.succeed('File queued for background processing')
                  } else {
                    spinner.succeed('File copied to inbox')
                    console.log(`    ${c.dim}Process with: datacore ingest ${singleDest}${c.reset}`)
                  }
                } else {
                  spinner.succeed('File copied to inbox')
                }
                totalImported++
              }
            } else {
              console.log(`  ${c.yellow}⚠${c.reset} Path not found: ${sourcePath}`)
            }
          }
        }

        console.log()
        importing = await confirm('  Import more?', false)
        if (importing) console.log()
      }

      console.log()
    }

    op.completeStep('import_data')

    // ═════════════════════════════════════════════════════════════════════
    // STEP 10/10: VERIFICATION
    // ═════════════════════════════════════════════════════════════════════
    op.addStep('verification')
    op.startStep('verification')

    const claudeAvailable = commandExists('claude')

    if (claudeAvailable && isTTY) {
      section(`Step 10/${TOTAL_STEPS}: Verification`)
      console.log()
      console.log(`  ${c.dim}Running AI verification to check everything is configured correctly...${c.reset}`)
      console.log()

      const spinner = new Spinner('Claude Code structural integrity check...')
      spinner.start()

      try {
        const agentResult = await invokeAgent(
          {
            agent: 'structural-integrity',
            params: { mode: 'report', scope: 'all' },
          },
          { cwd: DATA_DIR, timeout: 120000 },
        )

        if (agentResult.success) {
          spinner.succeed('All checks passed')
        } else {
          spinner.fail('Verification completed with issues')
          if (agentResult.error) {
            result.warnings.push(`Verification: ${agentResult.error}`)
          }
        }
      } catch {
        spinner.fail('Verification skipped (Claude Code not responding)')
        result.warnings.push('Could not run verification - run /structural-integrity manually')
      }

      // Show summary stats
      const allSpaces = listSpaces()
      const allInstalledModules = listModules()

      console.log()
      console.log(`    ${c.dim}Spaces:     ${allSpaces.length} (${allSpaces.map(s => s.name).join(', ')})${c.reset}`)
      console.log(`    ${c.dim}Modules:    ${allInstalledModules.length} installed${c.reset}`)

      // Count inbox items
      const inboxOrg = join(DATA_DIR, '0-personal', 'org', 'inbox.org')
      if (existsSync(inboxOrg)) {
        try {
          const content = readFileSync(inboxOrg, 'utf-8')
          const todoCount = (content.match(/^\* TODO /gm) || []).length
          if (todoCount > 0) {
            console.log(`    ${c.dim}GTD:        ${todoCount} inbox items${c.reset}`)
          }
        } catch {
          // Ignore
        }
      }

      // Count files in inbox
      const inboxDir = join(DATA_DIR, '0-personal', '0-inbox')
      if (existsSync(inboxDir)) {
        const { total } = countFiles(inboxDir)
        if (total > 0) {
          console.log(`    ${c.dim}Import:     ${total} files in inbox${c.reset}`)
        }
      }

      console.log()
    } else if (isTTY) {
      section(`Step 10/${TOTAL_STEPS}: Verification`)
      console.log()
      console.log(`  ${c.yellow}○${c.reset} Claude Code not available ${c.dim}(skipping verification)${c.reset}`)
      console.log(`  ${c.dim}Run /structural-integrity in Claude Code to verify later.${c.reset}`)
      console.log()
    }

    op.completeStep('verification')

    // ═════════════════════════════════════════════════════════════════════
    // SUCCESS
    // ═════════════════════════════════════════════════════════════════════
    if (userPrefixInstalls.length) {
      result.warnings.push(
        `npm's global directory was not writable, so ${userPrefixInstalls.join(', ')} ` +
        `installed into ${FALLBACK_NPM_PREFIX}/bin instead. MCP config records ` +
        'absolute paths, so this works as-is; add that directory to PATH if you ' +
        'want to run them by name.',
      )
    }

    // Modules that could not be cloned are usually PRIVATE repos the user has
    // no access to, which is expected and must not fail the install. What was
    // wrong was the silence: three modules vanished into the warnings list and
    // the summary still read like a complete setup.
    const failedModules = result.warnings
      .filter(w => /^Module .+ failed to install/.test(w))
      .map(w => w.replace(/^Module (\S+).*/, '$1'))
    if (failedModules.length && isTTY) {
      console.log()
      console.log(`  ${c.bold}${failedModules.length} module(s) not installed${c.reset} ${c.dim}(likely private repos you do not have access to)${c.reset}`)
      console.log(`  ${c.dim}${failedModules.join(', ')}${c.reset}`)
      console.log(`  ${c.dim}Datacore works without them. Re-run 'datacore init' after 'gh auth login' to retry.${c.reset}`)
    }

    const unresolvable = unresolvableMcpServers()
    if (unresolvable.length) {
      // The config entry is still written, so fixing PATH later just works —
      // but an install whose MCP servers cannot be launched is not a success,
      // and saying so is the difference between a user fixing it now and
      // discovering it when their assistant silently has no tools.
      result.errors.push(
        `MCP server binary not found for: ${unresolvable.join(', ')}. ` +
        'Claude Code will not be able to start ' +
        (unresolvable.length > 1 ? 'them' : 'it') + '. ' +
        'Install with: npm install -g ' +
        unresolvable.map(n => n === 'plur' ? '@plur-ai/mcp' : '@datacore-one/mcp').join(' '),
      )
    }

    if (permissionFailures.length) {
      result.warnings.push(
        "npm's global directory is not writable by this user, so " +
        `${permissionFailures.length} dependency install(s) failed: ` +
        permissionFailures.join('; ') +
        ' — or point npm at a user-owned prefix: ' +
        'npm config set prefix ~/.npm-global && export PATH=~/.npm-global/bin:$PATH',
      )
    }

    // ── Completion gate ────────────────────────────────────────────────
    // An install that ends with ~/Data a stub, no ~/.plur and nothing
    // registered used to report success-shaped state and say nothing. Assert
    // the things that must be true, and fail loudly naming each one that is
    // not — a first-run wizard that can end in an unreported half-state is
    // worse than one that fails, because the user then uses a system that is
    // quietly not there.
    const completion: { label: string; ok: boolean; fix: string }[] = [
      { label: '~/Data created', ok: existsSync(DATA_DIR),
        fix: 'datacore init --force' },
      { label: 'personal space', ok: existsSync(join(DATA_DIR, '0-personal')),
        fix: 'datacore init --force' },
      { label: 'GTD org files', ok: existsSync(join(DATA_DIR, '0-personal', 'org')),
        fix: 'datacore init --force' },
      { label: '.datacore present', ok: existsSync(DATACORE_DIR),
        fix: 'datacore init --force' },
      { label: 'git initialised', ok: existsSync(join(DATA_DIR, '.git')),
        fix: `git -C ${DATA_DIR} init` },
    ]
    const incomplete = completion.filter((c) => !c.ok)
    for (const c of incomplete) {
      result.errors.push(`Install incomplete — ${c.label} is missing. Fix: ${c.fix}`)
    }
    if (isTTY) {
      console.log()
      console.log(`  ${c.bold}Verifying your installation${c.reset}`)
      for (const chk of completion) {
        console.log(`    ${chk.ok ? c.green + '✓' : c.red + '✗'}${c.reset} ${chk.label}`)
      }
      if (incomplete.length) {
        console.log(`    ${c.dim}run \`datacore doctor\` for details${c.reset}`)
      }
    }

    result.success = unresolvable.length === 0 && incomplete.length === 0
    // Append, never assign: steps pushed by earlier phases (the Chief of
    // Staff persona path, for one) were being discarded by a bare assignment.
    result.nextSteps.push(
      `cd ${DATA_DIR} && claude`,
      'Run /today for your first daily briefing',
      'Process inbox with /gtd-daily-start',
      'Run datacore doctor to check system health',
    )

    await offerDesktopApp(isTTY, result)

    // Hand the facts to the assistant. `datacore init` finishes in a terminal
    // and says "cd ~/Data && claude" — and that next command used to open on a
    // blank prompt, identical to the ten-thousandth session. The installer knew
    // what it had just built and the assistant did not, so the first thing a
    // new user met was a stranger. session_bootstrap.py spends this marker on
    // the next session start and renames it first, so it greets exactly once.
    try {
      const allSpaces = listSpaces()
      const stateDir = join(DATACORE_DIR, 'state')
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(join(stateDir, 'first-run.json'), JSON.stringify({
        installedAt: new Date().toISOString(),
        dataDir: DATA_DIR,
        userName: profile.name || '',
        cosName: cosPersonaName(),
        spaces: allSpaces.map(s => s.name),
        modules: listModules().map(m => m.name),
        memoryConnected: mcpConfigured('plur'),
        hooksArmed: gitHooksConfigured(),
      }, null, 2))
    } catch (err) {
      // A missing greeting is not a failed install.
      result.warnings.push(`Could not record first-run greeting: ${(err as Error).message}`)
    }

    if (isTTY) {
      // The finish is an animation, but every line of it is something this run
      // actually did -- counted here, at the end, from the filesystem. An
      // installer that spent this release learning to stop reporting success it
      // had not earned does not get to close with invented progress.
      const allSpaces = listSpaces()
      const installedModules = listModules()
      const cosName = cosPersonaName()
      await completionSequence([
        { label: 'Knowledge base', value: DATA_DIR, ok: existsSync(DATA_DIR) },
        {
          label: 'Spaces',
          value: allSpaces.length ? allSpaces.map(s => s.name).join(', ') : 'none',
          ok: allSpaces.length > 0,
        },
        {
          label: 'Modules',
          value: installedModules.length
            ? `${installedModules.length} — ${installedModules.map(m => m.name).join(', ')}`
            : 'none',
          ok: installedModules.length > 0,
        },
        { label: 'Chief of Staff', value: cosName, ok: true },
        {
          label: 'Memory',
          value: mcpConfigured('plur') ? 'PLUR connected' : 'not connected',
          ok: mcpConfigured('plur'),
        },
        {
          label: 'Safety hooks',
          value: gitHooksConfigured() ? 'armed' : 'not configured',
          ok: gitHooksConfigured(),
        },
      ])
      console.log()
      console.log(`  ${c.bold}Setup Complete${profile.name ? `, ${profile.name}` : ''}!${c.reset}`)
      console.log()

      // API Keys guidance
      const envDir = join(DATACORE_DIR, 'env')
      const envFiles = existsSync(envDir) ? readdirSync(envDir).filter(f => f !== '.gitkeep') : []
      if (envFiles.length === 0) {
        console.log(`  ${c.bold}API Keys:${c.reset}`)
        console.log(`  ${c.dim}Some modules need API keys to function. Configure them in Claude Code:${c.reset}`)
        console.log(`    ${c.dim}cd ~/Data && claude${c.reset}`)
        console.log(`    ${c.dim}"Help me set up my API keys"${c.reset}`)
        console.log(`  ${c.dim}Keys are stored in .datacore/env/ - gitignored, never leave your machine.${c.reset}`)
        console.log()
      }

      // Warnings
      if (result.warnings.length > 0) {
        console.log(`  ${c.yellow}Warnings:${c.reset} ${result.warnings.length}`)
        for (const w of result.warnings) {
          console.log(`    ${c.dim}• ${w}${c.reset}`)
        }
        console.log()
      }

      // Get Started
      console.log(`  ${c.bold}Get Started:${c.reset}`)
      console.log()
      console.log(`  ${c.cyan}1.${c.reset} cd ~/Data && claude`)
      console.log(`     ${c.dim}Start Claude Code in your Datacore directory${c.reset}`)
      console.log()
      console.log(`  ${c.cyan}2.${c.reset} Type ${c.cyan}/today${c.reset}`)
      console.log(`     ${c.dim}Get your first daily briefing with your imported data${c.reset}`)
      console.log()

      // Count inbox items for contextual suggestion
      const inboxDir = join(DATA_DIR, '0-personal', '0-inbox')
      const inboxFileCount = existsSync(inboxDir) ? countFiles(inboxDir).total : 0
      if (inboxFileCount > 0) {
        console.log(`  ${c.cyan}3.${c.reset} Process your imports`)
        console.log(`     ${c.dim}${inboxFileCount} files in inbox - run /ingest in Claude Code${c.reset}`)
        console.log()
      } else {
        console.log(`  ${c.cyan}3.${c.reset} Process your inbox`)
        console.log(`     ${c.dim}Add tasks to org/inbox.org - try /gtd-daily-start${c.reset}`)
        console.log()
      }

      if (backgroundJobs.length > 0) {
        console.log(`  ${c.green}Background imports:${c.reset}`)
        for (const job of backgroundJobs) {
          if (verbose) {
            console.log(`    ${c.green}✓${c.reset} ${job.label} processing (PID ${job.pid})`)
            console.log(`      ${c.dim}Log: ${job.logFile}${c.reset}`)
          } else {
            console.log(`    ${c.green}✓${c.reset} ${job.label} processing`)
          }
        }
        console.log(`    ${c.dim}Check progress: datacore status${c.reset}`)
        console.log()
      }

      console.log(`  ${c.dim}Edit ~/Data/CLAUDE.local.md to teach Claude about you.${c.reset}`)
      console.log(`  ${c.dim}Run 'datacore doctor' anytime to check system health.${c.reset}`)
      console.log()
    }

    op.complete()

  } catch (err) {
    result.errors.push((err as Error).message)
    op.fail((err as Error).message)
  }

  return result
}
