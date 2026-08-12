/**
 * Dependency checking utilities.
 */

import { execSync, execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join, basename } from 'path'
import type { DependencyCheck, DoctorResult, LedgerCheck } from '../types'
import { detectPlatform, getInstallCommand, getPlatformInfo, type Platform } from './platform'
import { dataDir as resolveDataDir } from './paths'
import { findPython, PYTHON_MIN_VERSION } from './python'
import { listSpaces } from './space'

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function getVersion(cmd: string, versionFlag = '--version'): string | undefined {
  try {
    const output = execSync(`${cmd} ${versionFlag}`, { encoding: 'utf-8', stdio: 'pipe' })
    // Extract version number from output
    const match = output.match(/(\d+\.\d+(\.\d+)?)/)?.[0]
    return match ?? output.trim().split('\n')[0]?.slice(0, 30)
  } catch {
    return undefined
  }
}

function getGitConfig(key: string): string | undefined {
  try {
    return execSync(`git config --global ${key}`, { encoding: 'utf-8', stdio: 'pipe' }).trim()
  } catch {
    return undefined
  }
}

function checkGitHubAuth(): { authenticated: boolean; user?: string } {
  try {
    const output = execSync('gh auth status 2>&1', { encoding: 'utf-8', stdio: 'pipe' })
    const userMatch = output.match(/Logged in to github\.com.*account (\S+)/i)
    return { authenticated: true, user: userMatch?.[1] }
  } catch {
    return { authenticated: false }
  }
}

export interface GitStatus {
  installed: boolean
  version?: string
  configured: boolean
  userName?: string
  userEmail?: string
  githubAuth: boolean
  githubUser?: string
}

export function checkGitDetailed(): GitStatus {
  const installed = commandExists('git')
  if (!installed) {
    return { installed: false, configured: false, githubAuth: false }
  }

  const userName = getGitConfig('user.name')
  const userEmail = getGitConfig('user.email')
  const configured = !!(userName && userEmail)

  const ghInstalled = commandExists('gh')
  let githubAuth = false
  let githubUser: string | undefined

  if (ghInstalled) {
    const ghStatus = checkGitHubAuth()
    githubAuth = ghStatus.authenticated
    githubUser = ghStatus.user
  }

  return {
    installed: true,
    version: getVersion('git'),
    configured,
    userName,
    userEmail,
    githubAuth,
    githubUser,
  }
}

function checkGit(platform: Platform): DependencyCheck {
  const status = checkGitDetailed()
  return {
    name: 'git',
    required: true,
    installed: status.installed,
    version: status.version,
    installCommand: status.installed ? undefined : getInstallCommand('git', platform) ?? undefined,
  }
}

function checkGitLfs(platform: Platform): DependencyCheck {
  const installed = commandExists('git-lfs')
  return {
    name: 'git-lfs',
    required: false,  // Recommended for large files, not required for basic usage
    installed,
    version: installed ? getVersion('git-lfs') : undefined,
    installCommand: installed ? undefined : getInstallCommand('git-lfs', platform) ?? undefined,
  }
}

function checkNode(platform: Platform): DependencyCheck {
  const installed = commandExists('node')
  let version: string | undefined
  let meetsMin = false

  if (installed) {
    version = getVersion('node', '-v')
    // Check >= 20 (glob@11, jackspeak@4 etc require Node 20+)
    const major = parseInt(version?.replace('v', '').split('.')[0] ?? '0', 10)
    meetsMin = major >= 20
  }

  return {
    name: 'node',
    required: true,
    installed: installed && meetsMin,
    version,
    installCommand: (!installed || !meetsMin) ? getInstallCommand('node', platform) ?? undefined : undefined,
  }
}

function checkPython(platform: Platform): DependencyCheck {
  // Try python3 first, then python
  let installed = commandExists('python3')
  let cmd = 'python3'
  if (!installed) {
    installed = commandExists('python')
    cmd = 'python'
  }

  let version: string | undefined
  let meetsMin = false

  if (installed) {
    version = getVersion(cmd, '--version')
    // >= 3.10, NOT 3.9. Datacore's ledger modules use PEP-604 unions at
    // import time, so 3.9 does not degrade — it raises TypeError before
    // running anything. Reporting 3.9 as satisfying the requirement told
    // macOS users their install was fine when the ledger could not load.
    const match = version?.match(/(\d+)\.(\d+)/)
    if (match) {
      const major = parseInt(match[1] ?? '0', 10)
      const minor = parseInt(match[2] ?? '0', 10)
      meetsMin = major > 3 || (major === 3 && minor >= 10)
    }
  }

  return {
    name: 'python',
    required: true,
    installed: installed && meetsMin,
    version,
    installCommand: (!installed || !meetsMin) ? getInstallCommand('python', platform) ?? undefined : undefined,
  }
}

function checkGh(platform: Platform): DependencyCheck {
  const installed = commandExists('gh')
  let authenticated = false
  if (installed) {
    try {
      execSync('gh auth status', { stdio: 'pipe' })
      authenticated = true
    } catch {
      // Not authenticated
    }
  }
  return {
    name: 'gh',
    required: false,
    installed: installed && authenticated,
    version: installed ? getVersion('gh') : undefined,
    installCommand: installed
      ? (authenticated ? undefined : 'gh auth login')
      : getInstallCommand('gh', platform) ?? undefined,
  }
}

function checkClaude(platform: Platform): DependencyCheck {
  const installed = commandExists('claude')
  return {
    name: 'claude',
    required: false,
    installed,
    version: installed ? getVersion('claude', '--version') : undefined,
    installCommand: installed ? undefined : getInstallCommand('claude', platform) ?? undefined,
  }
}

function checkMcp(platform: Platform): DependencyCheck {
  const installed = commandExists('datacore-mcp')
  return {
    name: 'datacore-mcp',
    required: false,
    installed,
    version: installed ? getVersion('datacore-mcp', '--version') : undefined,
    installCommand: installed ? undefined : getInstallCommand('datacore-mcp', platform) ?? undefined,
  }
}

export function checkCodePermissions(): { enableAll: boolean; mcpAllowed: boolean } {
  const home = process.env.HOME || ''
  const settingsPaths = [
    join(home, 'Data', '.claude', 'settings.local.json'),
    join(home, 'Data', '.claude', 'settings.json'),
  ]

  let enableAll = false
  let mcpAllowed = false

  for (const p of settingsPaths) {
    try {
      if (existsSync(p)) {
        const content = JSON.parse(readFileSync(p, 'utf-8'))
        if (content?.enableAllProjectMcpServers) enableAll = true
        const allow = content?.permissions?.allow as string[] | undefined
        if (allow?.some((r: string) => r === 'mcp__datacore' || r.startsWith('mcp__datacore__'))) {
          mcpAllowed = true
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  return { enableAll, mcpAllowed }
}

export function checkMcpConfig(): { claudeDesktop: boolean; claudeCode: boolean } {
  // Check Claude Desktop config
  const home = process.env.HOME || ''
  const desktopPaths = [
    join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), // macOS
    join(home, '.config', 'claude', 'claude_desktop_config.json'), // Linux
  ]

  let claudeDesktop = false
  for (const p of desktopPaths) {
    try {
      if (existsSync(p)) {
        const content = JSON.parse(readFileSync(p, 'utf-8'))
        if (content?.mcpServers?.datacore) {
          claudeDesktop = true
          break
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Check Claude Code .mcp.json
  let claudeCode = false
  const mcpJsonPath = join(home, 'Data', '.mcp.json')
  try {
    if (existsSync(mcpJsonPath)) {
      const content = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'))
      if (content?.mcpServers?.datacore) {
        claudeCode = true
      }
    }
  } catch {
    // Ignore parse errors
  }

  return { claudeDesktop, claudeCode }
}

export function checkDependencies(): DependencyCheck[] {
  const platform = detectPlatform()

  return [
    checkGit(platform),
    checkGitLfs(platform),
    checkNode(platform),
    checkPython(platform),
    checkGh(platform),
    checkClaude(platform),
    checkMcp(platform),
  ]
}

export function checkDatacore(): { exists: boolean; configured: boolean; spaces: number } {
  const dataDir = resolveDataDir()
  const exists = existsSync(dataDir)
  const configured = exists && existsSync(join(dataDir, '.datacore'))

  let spaces = 0
  if (exists) {
    try {
      const { readdirSync } = require('fs')
      const entries = readdirSync(dataDir, { withFileTypes: true }) as Array<{ isDirectory(): boolean; name: string }>
      spaces = entries.filter(e => e.isDirectory() && /^\d+-/.test(e.name)).length
    } catch {
      // Ignore
    }
  }

  return { exists, configured, spaces }
}

/**
 * Ask the ledger whether it is intact.
 *
 * doctor used to report "System ready for Datacore" from dependency versions
 * and config file presence alone — every one of which can be perfect on an
 * installation whose event chain is broken, whose actor identity resolves to
 * the wrong machine, or whose Python cannot load the ledger at all. After an
 * update, "did it work?" is the only question worth asking, and doctor could
 * not answer it.
 *
 * Each check returns ok:null rather than false when it cannot run, so an
 * installation that predates the ledger reports "not present" instead of
 * "broken" — those need different actions from whoever reads this.
 */
function checkLedger(): LedgerCheck[] {
  const checks: LedgerCheck[] = []
  const root = resolveDataDir()

  const python = findPython()
  if (!python) {
    checks.push({
      name: 'python',
      ok: false,
      // Naming the floor matters: macOS ships 3.9 as `python3`, so "install
      // Python" is the wrong instruction and sends people in a circle.
      detail: `no interpreter >= ${PYTHON_MIN_VERSION} found (macOS system python3 is 3.9 and cannot load the ledger) — set DATACORE_PYTHON`,
    })
    return checks
  }
  checks.push({ name: 'python', ok: true, detail: python })

  const ledgerCli = join(root, '.datacore', 'lib', 'ledger_cli.py')
  if (!existsSync(ledgerCli)) {
    checks.push({
      name: 'ledger',
      ok: null,
      detail: 'not present in this installation (pre-ledger) — run: datacore update',
    })
    return checks
  }

  // Verify every writer's hash chain, per space. A space whose chain is broken
  // cannot be folded into trustworthy state, so this is the load-bearing check.
  let spaces: string[] = []
  try {
    spaces = listSpaces()
      .map((s) => s.path)
      .filter((p) => existsSync(join(p, '.datacore', 'events')))
  } catch {
    spaces = []
  }

  if (spaces.length === 0) {
    checks.push({ name: 'chains', ok: null, detail: 'no space carries an event log yet' })
    return checks
  }

  const broken: string[] = []
  const unverifiable: string[] = []
  for (const space of spaces) {
    try {
      execFileSync(python, [ledgerCli, 'verify', '--space', space], {
        encoding: 'utf-8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string }
      // A non-zero exit is a real verdict (chain broken). A spawn failure is
      // not — it means we never got an answer, which is a different finding.
      if (typeof e.status === 'number') broken.push(basename(space))
      else unverifiable.push(basename(space))
    }
  }

  if (broken.length > 0) {
    checks.push({
      name: 'chains',
      ok: false,
      detail: `hash chain broken in ${broken.join(', ')} — do NOT publish; run: ledger_cli.py verify`,
    })
  } else if (unverifiable.length > 0 && unverifiable.length === spaces.length) {
    checks.push({ name: 'chains', ok: null, detail: `could not verify ${unverifiable.join(', ')}` })
  } else {
    const n = spaces.length - unverifiable.length
    checks.push({
      name: 'chains',
      ok: true,
      detail: `${n} space(s) verified` + (unverifiable.length ? `, ${unverifiable.length} unverifiable` : ''),
    })
  }

  // The transport is what makes `datacore update` safe. Its absence is why the
  // CLI falls back to a merge pull, so say so rather than leaving it implied.
  const transport = join(root, '.datacore', 'lib', 'ledger_transport.py')
  checks.push(
    existsSync(transport)
      ? { name: 'transport', ok: true, detail: 'ledger_transport.py (merge, never rebase)' }
      : { name: 'transport', ok: null, detail: 'absent — sync falls back to a plain merge pull' },
  )

  return checks
}

export function runDoctor(): DoctorResult {
  const { platform, arch, release } = getPlatformInfo()
  const dependencies = checkDependencies()
  const datacore = checkDatacore()

  const missingRequired = dependencies.some(d => d.required && !d.installed)
  const missingRecommended = dependencies.some(d => !d.required && !d.installed)

  const ledger = checkLedger()

  let status: DoctorResult['status'] = 'ready'
  if (missingRequired) status = 'missing_required'
  else if (missingRecommended) status = 'missing_recommended'
  // A broken chain outranks a missing optional dependency: it is the one
  // condition here that makes the installation's own history untrustworthy.
  if (ledger.some((c) => c.ok === false)) status = 'ledger_degraded'

  const py = findPython()

  return {
    platform: `${platform} (${release})`,
    arch,
    home: process.env.HOME || '~',
    dataDir: resolveDataDir(),
    python: { path: py },
    datacoreExists: datacore.exists,
    dependencies,
    status,
    mcpConfig: checkMcpConfig(),
    codePermissions: checkCodePermissions(),
    ledger,
  }
}
