/**
 * Update an existing Datacore installation.
 *
 * Single command that does everything:
 *   datacore update    - Pull repos, update modules, install MCP,
 *                        configure Claude, rebuild CLAUDE.md, snapshot
 *
 * Idempotent and safe to run repeatedly.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { createInterface } from 'readline'
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
  /** Skip dependency installation */
  skipDeps?: boolean
  /** Non-interactive mode (use defaults) */
  yes?: boolean
}

export interface UpdateResult {
  success: boolean
  updated: string[]
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

// ═══════════════════════════════════════════════════════════════════════════════
// Step 1: Pull repos
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

// ═══════════════════════════════════════════════════════════════════════════════
// Step 2: Update modules
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// Step 3: Dependencies (MCP server)
// ═══════════════════════════════════════════════════════════════════════════════

function upgradeDependencies(
  platform: Platform,
  isTTY: boolean,
  result: UpdateResult,
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
          result.updated.push('datacore-mcp installed')
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

// ═══════════════════════════════════════════════════════════════════════════════
// Step 4: MCP configuration
// ═══════════════════════════════════════════════════════════════════════════════

/** MCP config entry using global npm install binary */
const MCP_ENTRY = { command: 'datacore-mcp' }

type McpTarget = 'code' | 'desktop' | 'both'

function detectClaudeDesktopConfigDir(): string | null {
  const home = process.env.HOME || ''
  const paths = [
    join(home, 'Library', 'Application Support', 'Claude'), // macOS
    join(home, '.config', 'claude'),                         // Linux
  ]
  for (const dir of paths) {
    if (existsSync(dir)) return dir
  }
  return null
}

function configureMcpForDesktop(isTTY: boolean, result: UpdateResult): boolean {
  const dir = detectClaudeDesktopConfigDir()
  if (!dir) {
    if (isTTY) console.log(`  ${c.dim}○ Claude Desktop not found${c.reset}`)
    return false
  }

  const configPath = join(dir, 'claude_desktop_config.json')
  try {
    let config: Record<string, unknown> = {}
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8'))
    }

    const servers = (config.mcpServers || {}) as Record<string, unknown>
    if (!servers.datacore) {
      servers.datacore = MCP_ENTRY
      config.mcpServers = servers
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Claude Desktop configured`)
      result.updated.push('MCP configured for Claude Desktop')
    } else {
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Claude Desktop ${c.dim}(already configured)${c.reset}`)
      result.alreadyCurrent.push('MCP: Claude Desktop')
    }
    return true
  } catch {
    result.warnings.push('Could not configure MCP for Claude Desktop')
    return false
  }
}

function configureMcpForCode(isTTY: boolean, result: UpdateResult): boolean {
  const mcpJsonPath = join(DATA_DIR, '.mcp.json')
  try {
    let config: Record<string, unknown> = {}
    if (existsSync(mcpJsonPath)) {
      config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'))
    }

    const servers = (config.mcpServers || {}) as Record<string, unknown>
    if (!servers.datacore) {
      servers.datacore = MCP_ENTRY
      config.mcpServers = servers
      writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + '\n')
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Claude Code configured`)
      result.updated.push('MCP configured for Claude Code')
    } else {
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Claude Code ${c.dim}(already configured)${c.reset}`)
      result.alreadyCurrent.push('MCP: Claude Code')
    }
    return true
  } catch {
    result.warnings.push('Could not configure MCP for Claude Code')
    return false
  }
}

async function upgradeMcpConfig(
  isTTY: boolean,
  interactive: boolean,
  result: UpdateResult,
): Promise<void> {
  if (isTTY) {
    console.log(`${c.bold}MCP Server${c.reset}`)
  }

  // Check if MCP is even installed
  if (!commandExists('datacore-mcp')) {
    if (isTTY) console.log(`  ${c.dim}○ datacore-mcp not installed, skipping configuration${c.reset}`)
    if (isTTY) console.log()
    return
  }

  // Check if already configured everywhere
  const mcpJsonPath = join(DATA_DIR, '.mcp.json')
  const codeConfigured = existsSync(mcpJsonPath) &&
    !!(JSON.parse(readFileSync(mcpJsonPath, 'utf-8')) as Record<string, unknown>).mcpServers &&
    !!((JSON.parse(readFileSync(mcpJsonPath, 'utf-8')) as Record<string, Record<string, unknown>>).mcpServers?.datacore)

  const desktopDir = detectClaudeDesktopConfigDir()
  let desktopConfigured = false
  if (desktopDir) {
    const desktopPath = join(desktopDir, 'claude_desktop_config.json')
    try {
      if (existsSync(desktopPath)) {
        const cfg = JSON.parse(readFileSync(desktopPath, 'utf-8')) as Record<string, Record<string, unknown>>
        desktopConfigured = !!cfg.mcpServers?.datacore
      }
    } catch { /* ignore */ }
  }

  // If both (or the only available one) are already configured, just report
  if (codeConfigured && (desktopConfigured || !desktopDir)) {
    configureMcpForCode(isTTY, result)
    if (desktopDir) configureMcpForDesktop(isTTY, result)
    if (isTTY) console.log()
    return
  }

  // Need to configure at least one target
  let target: McpTarget = 'code' // default

  if (interactive && desktopDir) {
    // Both Claude Code and Desktop are available — ask user
    console.log()
    console.log(`  Where should the MCP server be configured?`)
    const choice = await choose('  Choose', [
      'Claude Code (recommended)',
      'Claude Desktop',
      'Both',
    ], 0)
    target = (['code', 'desktop', 'both'] as const)[choice]
  } else if (!desktopDir) {
    target = 'code'
  }

  if (target === 'code' || target === 'both') {
    configureMcpForCode(isTTY, result)
  }
  if (target === 'desktop' || target === 'both') {
    configureMcpForDesktop(isTTY, result)
  }

  if (isTTY) console.log()
}

// ═══════════════════════════════════════════════════════════════════════════════
// Step 5: Runtime directories
// ═══════════════════════════════════════════════════════════════════════════════

function upgradeDirectories(result: UpdateResult): void {
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
    result.updated.push('Runtime directories created')
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Step 6: Rebuild CLAUDE.md
// ═══════════════════════════════════════════════════════════════════════════════

function upgradeClaudeMd(
  isTTY: boolean,
  result: UpdateResult,
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
    result.updated.push('CLAUDE.md rebuilt')
  } else {
    if (isTTY) console.log(`  ${c.yellow}⚠${c.reset} CLAUDE.md rebuild failed`)
    result.warnings.push('Could not rebuild CLAUDE.md')
  }

  if (isTTY) console.log()
}

// ═══════════════════════════════════════════════════════════════════════════════
// Step 7: Snapshot
// ═══════════════════════════════════════════════════════════════════════════════

function upgradeSnapshot(
  isTTY: boolean,
  result: UpdateResult,
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

// ═══════════════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════════════

export async function updateDatacore(options: UpdateOptions = {}): Promise<UpdateResult> {
  const { stream = false, skipModules = false, skipDeps = false, yes = false } = options
  const isTTY = stream && !!process.stdout.isTTY
  const interactive = isTTY && !yes
  const platform = detectPlatform()

  const result: UpdateResult = {
    success: false,
    updated: [],
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
    console.log(`${c.bold}Updating Datacore...${c.reset}`)
    console.log()
  }

  // Step 1: Pull all repos
  updateRepos(isTTY, result)

  // Step 2: Update modules
  if (!skipModules) {
    updateModulesStep(isTTY, result)
  }

  // Step 3: Dependencies (MCP server)
  if (!skipDeps) {
    upgradeDependencies(platform, isTTY, result)
  }

  // Step 4: MCP configuration
  await upgradeMcpConfig(isTTY, interactive, result)

  // Step 5: Ensure runtime directories
  upgradeDirectories(result)

  // Step 6: Rebuild CLAUDE.md
  upgradeClaudeMd(isTTY, result)

  // Step 7: Snapshot
  upgradeSnapshot(isTTY, result)

  result.success = result.errors.length === 0
  return result
}

/** Exported for init.ts to reuse */
export { MCP_ENTRY, configureMcpForCode, configureMcpForDesktop }
