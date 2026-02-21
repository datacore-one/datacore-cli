/**
 * Update and upgrade an existing Datacore installation.
 *
 * Two commands, like apt/brew:
 *
 *   datacore update    - Fetch latest: git pull repos, update modules,
 *                        check for new CLI/MCP versions on npm
 *
 *   datacore upgrade   - Apply changes: install new deps, configure MCP,
 *                        rebuild CLAUDE.md, create snapshot
 *
 * Both are idempotent and safe to run repeatedly.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { detectPlatform, getInstallCommand, type Platform } from './platform'
import { updateModules, listModules } from './module'
import { createSnapshot, saveSnapshot } from './snapshot'
import { pullAll } from './sync'

// ─── Constants ────────────────────────────────────────────────────────────────

const DATA_DIR = join(process.env.HOME || '', 'Data')
const DATACORE_DIR = join(DATA_DIR, '.datacore')

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UpdateOptions {
  /** Stream output (enables display in TTY) */
  stream?: boolean
  /** Skip module updates */
  skipModules?: boolean
}

export interface UpdateResult {
  success: boolean
  updated: string[]
  warnings: string[]
  errors: string[]
  alreadyCurrent: string[]
  /** New versions available on npm (not yet installed) */
  available: Array<{ name: string; current?: string; latest: string }>
}

export interface UpgradeOptions {
  /** Stream output (enables display in TTY) */
  stream?: boolean
  /** Skip dependency installation */
  skipDeps?: boolean
}

export interface UpgradeResult {
  success: boolean
  upgraded: string[]
  warnings: string[]
  errors: string[]
  alreadyCurrent: string[]
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
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function runArgs(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'pipe', cwd: opts?.cwd, timeout: opts?.timeout })
    return true
  } catch {
    return false
  }
}

/**
 * Check npm registry for latest version of a package.
 */
async function checkNpmVersion(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = await res.json() as { version: string }
    return data.version
  } catch {
    return null
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE — fetch latest from all sources
// ═══════════════════════════════════════════════════════════════════════════════

function updateRepos(
  isTTY: boolean,
  result: UpdateResult,
): void {
  if (isTTY) {
    console.log(`${c.bold}Repositories${c.reset}`)
  }

  const pullResults = pullAll({ stream: false })

  for (const r of pullResults) {
    if (r.success) {
      const upToDate = r.output.includes('Already up to date') || r.output.includes('Current branch')
      if (upToDate) {
        if (isTTY) console.log(`  ${c.green}✓${c.reset} ${r.name} ${c.dim}(up to date)${c.reset}`)
        result.alreadyCurrent.push(r.name)
      } else {
        if (isTTY) console.log(`  ${c.green}✓${c.reset} ${r.name} ${c.dim}(updated)${c.reset}`)
        result.updated.push(`Repo: ${r.name}`)
      }
    } else {
      if (isTTY) console.log(`  ${c.yellow}⚠${c.reset} ${r.name} ${c.dim}(${r.error?.split('\n')[0] || 'failed'})${c.reset}`)
      result.warnings.push(`${r.name}: ${r.error?.split('\n')[0] || 'pull failed'}`)
    }
  }

  if (isTTY) console.log()
}

function updateModulesStep(
  isTTY: boolean,
  result: UpdateResult,
): void {
  if (isTTY) {
    console.log(`${c.bold}Modules${c.reset}`)
  }

  const modules = listModules()
  if (modules.length === 0) {
    if (isTTY) console.log(`  ${c.dim}No modules installed${c.reset}`)
    if (isTTY) console.log()
    return
  }

  const results = updateModules()

  let updated = 0
  let upToDate = 0
  let failed = 0

  for (const r of results) {
    if (r.updated) {
      updated++
      result.updated.push(`Module: ${r.name}`)
    } else if (r.error) {
      failed++
      result.warnings.push(`Module ${r.name}: ${r.error}`)
    } else {
      upToDate++
    }
  }

  if (isTTY) {
    if (updated > 0) console.log(`  ${c.green}✓${c.reset} ${updated} module(s) updated`)
    if (upToDate > 0) console.log(`  ${c.green}✓${c.reset} ${upToDate} module(s) already current`)
    if (failed > 0) console.log(`  ${c.yellow}⚠${c.reset} ${failed} module(s) failed to update`)
    console.log()
  }
}

async function checkAvailableVersions(
  isTTY: boolean,
  result: UpdateResult,
): Promise<void> {
  if (isTTY) {
    console.log(`${c.bold}Package Versions${c.reset}`)
  }

  // Check CLI version
  const cliCurrent = getVersionString('datacore', '--version')
  const cliLatest = await checkNpmVersion('@datacore-one/cli')
  if (cliLatest && cliCurrent && cliLatest !== cliCurrent) {
    result.available.push({ name: '@datacore-one/cli', current: cliCurrent, latest: cliLatest })
    if (isTTY) console.log(`  ${c.cyan}↑${c.reset} CLI ${c.dim}${cliCurrent} → ${cliLatest}${c.reset}  ${c.dim}(npm update -g @datacore-one/cli)${c.reset}`)
  } else if (cliCurrent) {
    if (isTTY) console.log(`  ${c.green}✓${c.reset} CLI ${c.dim}(${cliCurrent})${c.reset}`)
  }

  // Check MCP version
  const mcpCurrent = getVersionString('datacore-mcp', '--version')
  const mcpLatest = await checkNpmVersion('@datacore-one/mcp')
  if (mcpLatest && mcpCurrent && mcpLatest !== mcpCurrent) {
    result.available.push({ name: '@datacore-one/mcp', current: mcpCurrent, latest: mcpLatest })
    if (isTTY) console.log(`  ${c.cyan}↑${c.reset} MCP ${c.dim}${mcpCurrent} → ${mcpLatest}${c.reset}  ${c.dim}(npm update -g @datacore-one/mcp)${c.reset}`)
  } else if (mcpCurrent) {
    if (isTTY) console.log(`  ${c.green}✓${c.reset} MCP ${c.dim}(${mcpCurrent})${c.reset}`)
  } else if (!mcpCurrent && mcpLatest) {
    result.available.push({ name: '@datacore-one/mcp', latest: mcpLatest })
    if (isTTY) console.log(`  ${c.cyan}+${c.reset} MCP ${c.dim}not installed (${mcpLatest} available)${c.reset}  ${c.dim}(datacore upgrade)${c.reset}`)
  }

  if (isTTY) console.log()
}

export async function updateDatacore(options: UpdateOptions = {}): Promise<UpdateResult> {
  const { stream = false, skipModules = false } = options
  const isTTY = stream && !!process.stdout.isTTY

  const result: UpdateResult = {
    success: false,
    updated: [],
    warnings: [],
    errors: [],
    alreadyCurrent: [],
    available: [],
  }

  if (!existsSync(DATACORE_DIR)) {
    result.errors.push('Datacore not initialized. Run: datacore init')
    return result
  }

  if (isTTY) {
    console.log()
    console.log(`${c.bold}Updating Datacore...${c.reset}`)
    console.log()
  }

  // Step 1: Pull all repos
  updateRepos(isTTY, result)

  // Step 2: Update modules
  if (!skipModules) {
    updateModulesStep(isTTY, result)
  }

  // Step 3: Check npm for new versions
  await checkAvailableVersions(isTTY, result)

  // Summary hint
  if (isTTY && result.available.length > 0) {
    console.log(`${c.dim}New versions available. Update packages, then run: datacore upgrade${c.reset}`)
    console.log()
  }

  result.success = result.errors.length === 0
  return result
}

// ═══════════════════════════════════════════════════════════════════════════════
// UPGRADE — apply structural changes to the installation
// ═══════════════════════════════════════════════════════════════════════════════

function upgradeDependencies(
  platform: Platform,
  isTTY: boolean,
  result: UpgradeResult,
): void {
  if (isTTY) {
    console.log(`${c.bold}Dependencies${c.reset}`)
  }

  // Check MCP server
  if (commandExists('datacore-mcp')) {
    const version = getVersionString('datacore-mcp', '--version')
    if (isTTY) console.log(`  ${c.green}✓${c.reset} datacore-mcp ${c.dim}(${version})${c.reset}`)
    result.alreadyCurrent.push('datacore-mcp')
  } else {
    const installCmd = getInstallCommand('datacore-mcp', platform)
    if (installCmd) {
      if (isTTY) process.stdout.write(`  Installing datacore-mcp...`)
      try {
        execFileSync('/bin/bash', ['-c', installCmd], { stdio: 'pipe', timeout: 300000 })
        if (commandExists('datacore-mcp')) {
          const version = getVersionString('datacore-mcp', '--version')
          if (isTTY) console.log(`\r  ${c.green}✓${c.reset} datacore-mcp installed ${c.dim}(${version})${c.reset}`)
          result.upgraded.push('datacore-mcp installed')
        } else {
          if (isTTY) console.log(`\r  ${c.yellow}⚠${c.reset} datacore-mcp install completed but not in PATH`)
          result.warnings.push('datacore-mcp installed but not found in PATH')
        }
      } catch {
        if (isTTY) console.log(`\r  ${c.red}✗${c.reset} datacore-mcp install failed`)
        result.warnings.push(`Install manually: ${installCmd}`)
      }
    }
  }

  // Check Claude Code
  if (commandExists('claude')) {
    const version = getVersionString('claude', '--version')
    if (isTTY) console.log(`  ${c.green}✓${c.reset} claude ${c.dim}(${version})${c.reset}`)
    result.alreadyCurrent.push('claude')
  } else {
    if (isTTY) console.log(`  ${c.dim}○ claude not installed (recommended)${c.reset}`)
  }

  if (isTTY) console.log()
}

function upgradeMcpConfig(
  isTTY: boolean,
  result: UpgradeResult,
): void {
  if (isTTY) {
    console.log(`${c.bold}MCP Server Configuration${c.reset}`)
  }

  const mcpEntry = { command: 'npx', args: ['@datacore-one/mcp'] }
  const home = process.env.HOME || ''

  // 1. Claude Desktop config
  const desktopPaths = [
    join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    join(home, '.config', 'claude', 'claude_desktop_config.json'),
  ]

  for (const configPath of desktopPaths) {
    try {
      const dir = join(configPath, '..')
      if (!existsSync(dir)) continue

      let config: Record<string, unknown> = {}
      if (existsSync(configPath)) {
        config = JSON.parse(readFileSync(configPath, 'utf-8'))
      }

      const servers = (config.mcpServers || {}) as Record<string, unknown>
      if (!servers.datacore) {
        servers.datacore = mcpEntry
        config.mcpServers = servers
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
        if (isTTY) console.log(`  ${c.green}✓${c.reset} Claude Desktop configured`)
        result.upgraded.push('MCP configured for Claude Desktop')
      } else {
        if (isTTY) console.log(`  ${c.green}✓${c.reset} Claude Desktop ${c.dim}(already configured)${c.reset}`)
        result.alreadyCurrent.push('MCP: Claude Desktop')
      }
      break
    } catch {
      // Skip this path
    }
  }

  // 2. Claude Code .mcp.json
  const mcpJsonPath = join(DATA_DIR, '.mcp.json')
  try {
    let config: Record<string, unknown> = {}
    if (existsSync(mcpJsonPath)) {
      config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'))
    }

    const servers = (config.mcpServers || {}) as Record<string, unknown>
    if (!servers.datacore) {
      servers.datacore = mcpEntry
      config.mcpServers = servers
      writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + '\n')
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Claude Code .mcp.json configured`)
      result.upgraded.push('MCP configured for Claude Code')
    } else {
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Claude Code .mcp.json ${c.dim}(already configured)${c.reset}`)
      result.alreadyCurrent.push('MCP: Claude Code')
    }
  } catch {
    result.warnings.push('Could not configure MCP for Claude Code')
  }

  if (isTTY) console.log()
}

function upgradeDirectories(
  _isTTY: boolean,
  result: UpgradeResult,
): void {
  const stateDir = join(DATACORE_DIR, 'state')
  const envDir = join(DATACORE_DIR, 'env')

  let created = false
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, '.gitkeep'), '')
    created = true
  }
  if (!existsSync(envDir)) {
    mkdirSync(envDir, { recursive: true })
    writeFileSync(join(envDir, '.gitkeep'), '')
    created = true
  }

  if (created) {
    result.upgraded.push('Runtime directories created')
  }
}

function upgradeClaudeMd(
  isTTY: boolean,
  result: UpgradeResult,
): void {
  if (isTTY) {
    console.log(`${c.bold}Context Files${c.reset}`)
  }

  const contextMerge = join(DATACORE_DIR, 'lib', 'context_merge.py')
  if (!existsSync(contextMerge)) {
    if (isTTY) console.log(`  ${c.dim}○ context_merge.py not found (skipping)${c.reset}`)
    if (isTTY) console.log()
    return
  }

  if (runArgs('python3', [contextMerge, 'rebuild', '--path', DATA_DIR, '--all'])) {
    if (isTTY) console.log(`  ${c.green}✓${c.reset} CLAUDE.md rebuilt from layers`)
    result.upgraded.push('CLAUDE.md rebuilt')
  } else {
    if (isTTY) console.log(`  ${c.yellow}⚠${c.reset} CLAUDE.md rebuild failed`)
    result.warnings.push('Could not rebuild CLAUDE.md')
  }

  if (isTTY) console.log()
}

function upgradeSnapshot(
  isTTY: boolean,
  result: UpgradeResult,
): void {
  if (isTTY) {
    console.log(`${c.bold}Snapshot${c.reset}`)
  }

  try {
    const snapshot = createSnapshot()
    saveSnapshot(snapshot)
    if (isTTY) console.log(`  ${c.green}✓${c.reset} Snapshot updated (datacore.lock.yaml)`)
  } catch {
    if (isTTY) console.log(`  ${c.yellow}⚠${c.reset} Could not create snapshot`)
    result.warnings.push('Snapshot creation failed')
  }

  if (isTTY) console.log()
}

export async function upgradeDatacore(options: UpgradeOptions = {}): Promise<UpgradeResult> {
  const { stream = false, skipDeps = false } = options
  const isTTY = stream && !!process.stdout.isTTY
  const platform = detectPlatform()

  const result: UpgradeResult = {
    success: false,
    upgraded: [],
    warnings: [],
    errors: [],
    alreadyCurrent: [],
  }

  if (!existsSync(DATACORE_DIR)) {
    result.errors.push('Datacore not initialized. Run: datacore init')
    return result
  }

  if (isTTY) {
    console.log()
    console.log(`${c.bold}Upgrading Datacore installation...${c.reset}`)
    console.log()
  }

  // Step 1: Dependencies
  if (!skipDeps) {
    upgradeDependencies(platform, isTTY, result)
  }

  // Step 2: MCP configuration
  upgradeMcpConfig(isTTY, result)

  // Step 3: Ensure runtime directories
  upgradeDirectories(isTTY, result)

  // Step 4: Rebuild CLAUDE.md
  upgradeClaudeMd(isTTY, result)

  // Step 5: Snapshot
  upgradeSnapshot(isTTY, result)

  result.success = result.errors.length === 0
  return result
}
