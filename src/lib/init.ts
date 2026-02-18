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
import { createSnapshot, saveSnapshot } from './snapshot'
import { startOperation } from '../state'
import { BANNER, INIT_COMPLETE, Spinner, sleep, section } from './animation'
import { spawnBackground, type BackgroundJob } from './background'

// ─── Constants ────────────────────────────────────────────────────────────────

const DATA_DIR = join(process.env.HOME || '', 'Data')
const DATACORE_DIR = join(DATA_DIR, '.datacore')
const UPSTREAM_REPO = 'datacore-one/datacore'
const TOTAL_STEPS = 9

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
    description: 'Datafund organization - strategy, operations, investor relations',
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
}

export interface InitResult {
  success: boolean
  created: string[]
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

async function prompt(question: string, defaultValue?: string): Promise<string> {
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

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]'
  const answer = await prompt(`${question} ${hint}`)
  if (!answer) return defaultYes
  return answer.toLowerCase().startsWith('y')
}

async function choose(question: string, options: string[], defaultIndex = 0): Promise<number> {
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

function isGitConfigured(): { name?: string; email?: string; configured: boolean } {
  const name = runArgsOutput('git', ['config', '--global', 'user.name'])
  const email = runArgsOutput('git', ['config', '--global', 'user.email'])
  return { name: name || undefined, email: email || undefined, configured: !!(name && email) }
}

// ─── Helpers: Dependencies ────────────────────────────────────────────────────

/**
 * Attempt to install a system dependency.
 * Returns success and version after install.
 */
async function ensureDependency(
  name: string,
  checkCmd: string,
  platform: Platform,
  isTTY: boolean,
  versionFlag = '--version',
): Promise<{ available: boolean; version?: string; wasInstalled: boolean }> {
  // Already available?
  if (commandExists(checkCmd)) {
    const version = getVersionString(checkCmd, versionFlag)
    return { available: true, version, wasInstalled: false }
  }

  // Get install command
  const installCmd = getInstallCommand(name, platform)
  if (!installCmd) {
    return { available: false, wasInstalled: false }
  }

  const spinner = isTTY ? new Spinner(`Installing ${name}...`) : null
  spinner?.start()

  try {
    // Install commands may contain shell operators (pipes, &&), so use bash
    execFileSync('/bin/bash', ['-c', installCmd], { stdio: 'pipe', timeout: 300000 })

    // Verify it's now available
    if (commandExists(checkCmd)) {
      const version = getVersionString(checkCmd, versionFlag)
      spinner?.succeed(`${name} installed${version ? ` (${version})` : ''}`)
      return { available: true, version, wasInstalled: true }
    }

    spinner?.fail(`${name} install completed but command not found in PATH`)
    if (isTTY) console.log(`    ${c.dim}Try manually: ${installCmd}${c.reset}`)
    return { available: false, wasInstalled: false }
  } catch {
    spinner?.fail(`Failed to install ${name}`)
    if (isTTY) console.log(`    ${c.dim}Try manually: ${installCmd}${c.reset}`)
    return { available: false, wasInstalled: false }
  }
}

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
function runModulePostInstall(modulePath: string): { ran: boolean; success: boolean; type?: string } {
  // Check for Python dependencies
  const reqTxt = join(modulePath, 'requirements.txt')
  if (existsSync(reqTxt)) {
    const ok = runArgs('python3', ['-m', 'pip', 'install', '-r', reqTxt, '--quiet'], { cwd: modulePath, timeout: 120000 })
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
  const isTTY = stream && process.stdout.isTTY
  const interactive = isTTY && !nonInteractive
  const platform = detectPlatform()

  const result: InitResult = {
    success: false,
    created: [],
    warnings: [],
    errors: [],
    nextSteps: [],
    spacesCreated: [],
    modulesInstalled: [],
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
    // STEP 1/9: ABOUT YOU
    // ═════════════════════════════════════════════════════════════════════
    op.addStep('about_you')
    op.startStep('about_you')

    if (interactive) {
      section(`Step 1/${TOTAL_STEPS}: About You`)
      console.log()
      console.log(`  ${c.dim}Let's personalize your setup. This configures your identity,${c.reset}`)
      console.log(`  ${c.dim}AI context layer, and tailors the experience to your needs.${c.reset}`)
      console.log()

      // Pre-fill from git config if available
      const gitConfig = isGitConfigured()
      if (gitConfig.name) profile.name = gitConfig.name
      if (gitConfig.email) profile.email = gitConfig.email

      profile.name = await prompt(`  Your name`, profile.name || undefined)
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
      profile.role = await prompt(`  Your role (e.g., developer, founder, researcher)`, '')

      console.log()
      console.log(`  ${c.green}✓${c.reset} Welcome, ${c.bold}${profile.name || 'friend'}${c.reset}!`)
      console.log()
    } else {
      // Non-interactive: fill from git config
      const gitConfig = isGitConfigured()
      if (gitConfig.name) profile.name = gitConfig.name
      if (gitConfig.email) profile.email = gitConfig.email
    }

    op.completeStep('about_you')

    // ═════════════════════════════════════════════════════════════════════
    // STEP 2/9: SYSTEM SETUP
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
      const node = await ensureDependency('node', 'node', platform, !!isTTY, '-v')
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

      // --- Claude Code (most critical tool) ---
      const claude = await ensureDependency('claude', 'claude', platform, !!isTTY)
      if (claude.available && !claude.wasInstalled && isTTY) {
        console.log(`  ${c.green}✓${c.reset} Claude Code ${c.dim}(${claude.version})${c.reset}`)
      }
      if (!claude.available) {
        result.warnings.push('Claude Code not installed - install with: npm install -g @anthropic-ai/claude-code')
      }

      // --- python ---
      const python = await ensureDependency('python', 'python3', platform, !!isTTY)
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

      // --- git-lfs ---
      const gitlfs = await ensureDependency('git-lfs', 'git-lfs', platform, !!isTTY)
      if (gitlfs.available && !gitlfs.wasInstalled && isTTY) {
        console.log(`  ${c.green}✓${c.reset} git-lfs ${c.dim}(${gitlfs.version})${c.reset}`)
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
    // STEP 3/9: SETTING UP REPOSITORY
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

      const forkExists = runArgs('gh', ['repo', 'view', `${ghUser}/datacore`], { cwd: process.env.HOME, timeout: 30000 })

      if (!forkExists) {
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
      if (runArgs('git', ['pull', '--rebase', '--autostash'], { cwd: DATA_DIR, timeout: 60000 })) {
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
        if (!force) {
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

        // --force: initialize git in the existing directory
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
          result.errors.push(`Git init failed: ${lastInitErr}`)
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

    // Initialize Git LFS for this repo
    if (commandExists('git-lfs') && existsSync(join(DATA_DIR, '.git'))) {
      const spinner = isTTY ? new Spinner('Initializing Git LFS...') : null
      spinner?.start()

      if (runArgs('git', ['lfs', 'install'], { cwd: DATA_DIR, timeout: 30000 })) {
        runArgs('git', ['lfs', 'pull'], { cwd: DATA_DIR, timeout: 120000 })
        spinner?.succeed('Git LFS initialized')
      } else {
        spinner?.fail('Git LFS init failed (non-fatal)')
      }
    }

    if (isTTY) console.log()
    op.completeStep('clone_repo')

    // ═════════════════════════════════════════════════════════════════════
    // STEP 4/9: TEAM SPACES
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
              // Not in registry - ask for URL or create local
              const repoUrl = await prompt('  Git repo URL (or Enter to create local)', '')

              if (repoUrl) {
                const currentSpaces = listSpaces()
                const nextNum = currentSpaces.length > 0
                  ? Math.max(...currentSpaces.map(s => s.number)) + 1
                  : 1
                const spacePath = join(DATA_DIR, `${nextNum}-${normalized}`)

                const spinner = new Spinner(`Cloning ${spaceName}...`)
                spinner.start()

                let cloned = runArgs('git', ['clone', repoUrl, spacePath], { timeout: 300000 })
                if (!cloned) {
                  const sshUrl = repoUrl.replace('https://github.com/', 'git@github.com:')
                  cloned = runArgs('git', ['clone', sshUrl, spacePath], { timeout: 300000 })
                }

                if (cloned) {
                  spinner.succeed(`Added space: ${nextNum}-${normalized}`)
                  result.spacesCreated.push(`${nextNum}-${normalized}`)
                } else {
                  spinner.fail(`Could not clone ${repoUrl}`)
                  result.warnings.push(`Failed to add space: ${spaceName}`)
                }
              } else {
                try {
                  const { createSpace } = await import('./space')
                  const space = createSpace(spaceName, 'team')
                  result.created.push(space.path)
                  result.spacesCreated.push(space.name)
                  console.log(`  ${c.green}✓${c.reset} Created ${space.name}/`)
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
    // STEP 5/9: YOUR SECOND BRAIN
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
        profile.role ? `Role: ${profile.role}` : '',
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
    // STEP 6/9: MODULES
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
    } else {
      // Non-interactive: install all modules
      modulesToInstall = [...allModules]
    }

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

    op.completeStep('modules')

    // ═════════════════════════════════════════════════════════════════════
    // STEP 7/9: FINALIZE
    // ═════════════════════════════════════════════════════════════════════
    op.addStep('finalize')
    op.startStep('finalize')

    if (isTTY) {
      section(`Step 7/${TOTAL_STEPS}: Finalize`)
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
          profile.role ? `  role: "${profile.role}"` : null,
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

    if (isTTY) console.log()
    op.completeStep('finalize')

    // ═════════════════════════════════════════════════════════════════════
    // STEP 8/9: IMPORT YOUR DATA
    // ═════════════════════════════════════════════════════════════════════
    op.addStep('import_data')
    op.startStep('import_data')

    const backgroundJobs: BackgroundJob[] = []
    const canBackgroundIngest = commandExists('datacore') && commandExists('claude')

    if (interactive) {
      section(`Step 8/${TOTAL_STEPS}: Import Your Data`)
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
    // STEP 9/9: VERIFICATION
    // ═════════════════════════════════════════════════════════════════════
    op.addStep('verification')
    op.startStep('verification')

    const claudeAvailable = commandExists('claude')

    if (claudeAvailable && isTTY) {
      section(`Step 9/${TOTAL_STEPS}: Verification`)
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
      section(`Step 9/${TOTAL_STEPS}: Verification`)
      console.log()
      console.log(`  ${c.yellow}○${c.reset} Claude Code not available ${c.dim}(skipping verification)${c.reset}`)
      console.log(`  ${c.dim}Run /structural-integrity in Claude Code to verify later.${c.reset}`)
      console.log()
    }

    op.completeStep('verification')

    // ═════════════════════════════════════════════════════════════════════
    // SUCCESS
    // ═════════════════════════════════════════════════════════════════════
    result.success = true
    result.nextSteps = [
      `cd ${DATA_DIR} && claude`,
      'Run /today for your first daily briefing',
      'Process inbox with /gtd-daily-start',
      'Run datacore doctor to check system health',
    ]

    if (isTTY) {
      console.log(INIT_COMPLETE)
      console.log()
      console.log(`  ${c.bold}Setup Complete${profile.name ? `, ${profile.name}` : ''}!${c.reset}`)
      console.log()

      // Spaces
      const allSpaces = listSpaces()
      if (allSpaces.length > 0) {
        console.log(`  ${c.green}Your Datacore:${c.reset}`)
        for (const s of allSpaces) {
          const icon = s.type === 'personal' ? '👤' : '👥'
          console.log(`    ${icon} ${s.name}`)
        }
        console.log()
      }

      // Modules
      const installedModules = listModules()
      if (installedModules.length > 0) {
        console.log(`  ${c.green}Modules:${c.reset} ${installedModules.map(m => m.name).join(', ')}`)
        console.log()
      }

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
