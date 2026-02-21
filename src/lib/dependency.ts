/**
 * Dependency checking utilities.
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { DependencyCheck, DoctorResult } from '../types'
import { detectPlatform, getInstallCommand, getPlatformInfo, type Platform } from './platform'

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
    // Check >= 3.9
    const match = version?.match(/(\d+)\.(\d+)/)
    if (match) {
      const major = parseInt(match[1] ?? '0', 10)
      const minor = parseInt(match[2] ?? '0', 10)
      meetsMin = major > 3 || (major === 3 && minor >= 9)
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
  const dataDir = join(process.env.HOME || '~', 'Data')
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

export function runDoctor(): DoctorResult {
  const { platform, arch, release } = getPlatformInfo()
  const dependencies = checkDependencies()
  const datacore = checkDatacore()

  const missingRequired = dependencies.some(d => d.required && !d.installed)
  const missingRecommended = dependencies.some(d => !d.required && !d.installed)

  let status: DoctorResult['status'] = 'ready'
  if (missingRequired) status = 'missing_required'
  else if (missingRecommended) status = 'missing_recommended'

  return {
    platform: `${platform} (${release})`,
    arch,
    home: process.env.HOME || '~',
    datacoreExists: datacore.exists,
    dependencies,
    status,
    mcpConfig: checkMcpConfig(),
  }
}
