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
import { execFileSync, homeDir, npmBinCandidates, runShell, which } from './exec'
import { harnessConfigs, windowsMcpEntry, windowsScriptFor, wireHarnesses, type McpEntry } from './harness'
import { mergeUpstream, upgradeMcpPackages } from './selfupdate'
import { createInterface } from 'readline'
import { detectPlatform, getInstallCommand, type Platform } from './platform'
import { updateModules, listModules } from './module'
import { dataDir } from './paths'
import { createSnapshot, saveSnapshot } from './snapshot'
import { pullAll } from './sync'

// ─── Constants ────────────────────────────────────────────────────────────────

// Resolved PER CALL, not frozen at import -- the same reason snapshot.ts says
// so. This file hardcoded `~/Data` while paths.ts:dataDir() already honoured
// DATACORE_ROOT, which is the bug init.ts had and had fixed. The consequence
// here was quieter and worse: `configureMcpForCode` writes `<root>/.mcp.json`,
// so an install pointed anywhere else wrote its MCP registration into the
// developer's REAL ~/Data instead of its own -- meaning the install under test
// had no .mcp.json at all, and the machine running the test had its live
// config written to by a throwaway install.
import { ensureDatacoreVenv, ensureModuleDeps } from './python-env'
const DATA_DIR = () => dataDir()
const DATACORE_DIR = () => join(dataDir(), '.datacore')

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


/** Point git at the repo's own safety hooks when nothing else is configured. */
function ensureSafetyHooks(isTTY: boolean, result: UpdateResult): void {
  const hooksDir = join(DATA_DIR(), '.datacore', 'githooks')
  if (!existsSync(hooksDir) || !existsSync(join(DATA_DIR(), '.git'))) return
  try {
    execFileSync('git', ['config', 'core.hooksPath'], { cwd: DATA_DIR(), stdio: 'pipe' })
    return // set already (by init, or deliberately by the user)
  } catch { /* unset: git exits 1 */ }
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.datacore/githooks'], { cwd: DATA_DIR(), stdio: 'pipe' })
    if (isTTY) console.log(`  ${c.green}✓${c.reset} safety hooks enabled ${c.dim}(core.hooksPath)${c.reset}`)
    result.updated.push('Git safety hooks enabled')
  } catch {
    result.warnings.push('Could not enable git safety hooks: git -C ~/Data config core.hooksPath .datacore/githooks')
  }
}

/** Where we install when npm's global prefix is not writable (see init.ts). */
export const FALLBACK_NPM_PREFIX = join(homeDir(), '.datacore', 'npm')

/**
 * Absolute path of a CLI binary, or null.
 *
 * Looks on PATH first, then in npm's configured global prefix, then in our
 * fallback prefix. The last two matter because a binary can be installed and
 * still be invisible to `which`: `npm config set prefix` without the matching
 * PATH export is the state the standard EACCES remedy leaves behind, and it
 * is extremely common.
 */
export function resolveBinary(cmd: string): string | null {
  const onPath = which(cmd)
  if (onPath) return onPath

  const candidates: string[] = []
  try {
    const prefix = execFileSync('npm', ['config', 'get', 'prefix'], { stdio: 'pipe' })
      .toString().trim()
    if (prefix && prefix !== 'undefined') candidates.push(...npmBinCandidates(prefix, cmd))
  } catch { /* npm not answering — fall through */ }
  // The fallback is installed with `-g --prefix`, so it has the same layout.
  candidates.push(...npmBinCandidates(FALLBACK_NPM_PREFIX, cmd))
  // PLUR's own installer puts a stable launcher here (`plur init`), which is
  // what its configs point at. Without it an install with a working PLUR
  // reported plur-mcp as missing and wrote an entry naming a bare command.
  candidates.push(join(homeDir(), '.plur', 'bin', cmd))

  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

function commandExists(cmd: string): boolean {
  return which(cmd) !== null
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

  // A forked install's `origin` is the user's own fork, which GitHub never
  // syncs, so the pull above brings in nothing from upstream. Merge upstream
  // explicitly; an install cloned straight from upstream has no `upstream`
  // remote and is fully served by the pull.
  const up = mergeUpstream(DATA_DIR())
  if (up.status === 'merged') {
    if (isTTY) console.log(`  ${c.green}✓${c.reset} Data ${c.dim}(merged latest from datacore-one/datacore${up.pushed ? ', pushed to your fork' : ''})${c.reset}`)
    result.updated.push('Repo: Data (merged upstream)')
    if (!up.pushed && up.detail) result.warnings.push(up.detail)
  } else if (up.status === 'dirty') {
    if (isTTY) console.log(`  ${c.yellow}⚠${c.reset} Data ${c.dim}(not updated from upstream: uncommitted changes)${c.reset}`)
    result.warnings.push(`Data not updated from upstream: ${up.detail}`)
  } else if (up.status === 'conflict') {
    if (isTTY) console.log(`  ${c.yellow}⚠${c.reset} Data ${c.dim}(upstream conflicts with your changes — nothing was changed)${c.reset}`)
    result.warnings.push(`Data not updated from upstream: your changes conflict in ${up.files!.join(', ')}. Nothing was changed; resolve with: git -C ~/Data merge upstream/main`)
  } else if (up.status === 'failed') {
    result.warnings.push(`Data not updated from upstream: ${up.detail}`)
  }

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
        runShell(installCmd, { stdio: 'pipe', timeout: 300000 })
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

/** MCP config entries using the globally installed binaries.
 *
 * Both servers are written together. Datacore organises and PLUR remembers;
 * configuring one without the other yields an assistant that can read your
 * notes but forgets every correction, which users report as a broken product
 * rather than a partial install.
 */
const MCP_BINARIES: Record<string, string> = {
  datacore: 'datacore-mcp',
  plur: 'plur-mcp',
}
const MCP_PACKAGE: Record<string, string> = {
  datacore: '@datacore-one/mcp',
  plur: '@plur-ai/mcp',
}

/**
 * The MCP entry for a server, preferring an ABSOLUTE path.
 *
 * Writing the bare command produced an install that reported success and did
 * not work: the binaries were on disk, `which` could not see them because the
 * npm prefix bin was not on PATH, and the config we wrote named a command the
 * client could not launch. The user saw "Datacore MCP not installed" warnings
 * next to a completed install, and Claude Code silently failed to start both
 * servers.
 *
 * An absolute path is immune to whatever PATH the MCP client happens to run
 * with, which is not the same PATH as the shell that ran the installer.
 */
function mcpEntry(name: string): McpEntry {
  const bin = MCP_BINARIES[name]!
  if (process.platform === 'win32') {
    // The resolved "binary" is an npm .cmd shim, which MCP clients spawning
    // without a shell cannot launch. Run node on the package's script.
    const prefixes: string[] = [FALLBACK_NPM_PREFIX]
    try {
      const p = execFileSync('npm', ['config', 'get', 'prefix'], { stdio: 'pipe' }).toString().trim()
      if (p && p !== 'undefined') prefixes.unshift(p)
    } catch { /* fall back to our own prefix */ }
    for (const prefix of prefixes) {
      const script = windowsScriptFor(prefix, MCP_PACKAGE[name]!, bin)
      if (script && existsSync(script)) return windowsMcpEntry(process.execPath, script)
    }
  }
  return { command: resolveBinary(bin) ?? bin }
}

/** Both server entries, as every harness should launch them. */
export function mcpServerEntries(): Record<string, McpEntry> {
  return Object.fromEntries(Object.keys(MCP_BINARIES).map((n) => [n, mcpEntry(n)]))
}

/**
 * Codex, Antigravity, Gemini CLI, Windsurf and Cursor — whichever are
 * installed. Claude Code and Claude Desktop keep their own writers above.
 */
export function configureOtherHarnesses(isTTY: boolean, result: { updated: string[]; warnings: string[]; alreadyCurrent: string[] }): void {
  const r = wireHarnesses(mcpServerEntries(), DATA_DIR(), { skip: ['claude-desktop'] })
  for (const h of r.configured) {
    if (isTTY) console.log(`  ${c.green}✓${c.reset} ${h} configured`)
    result.updated.push(`MCP configured for ${h}`)
  }
  for (const h of r.alreadyCurrent) {
    if (isTTY) console.log(`  ${c.green}✓${c.reset} ${h} ${c.dim}(already configured)${c.reset}`)
    result.alreadyCurrent.push(`MCP: ${h}`)
  }
  for (const w of r.warnings) {
    if (isTTY) console.log(`  ${c.yellow}⚠${c.reset} ${w}`)
    result.warnings.push(w)
  }
}

/** Add any missing server to `servers`. Returns the names actually added. */
function addMissingServers(servers: Record<string, unknown>): string[] {
  const added: string[] = []
  for (const name of Object.keys(MCP_BINARIES)) {
    if (!servers[name]) {
      servers[name] = mcpEntry(name)
      added.push(name)
    }
  }
  return added
}

/** Server names whose binary cannot be found anywhere. Their config entry is
 *  still written — a later PATH fix should just work — but the caller must
 *  not report an install that launches nothing as a success. */
export function unresolvableMcpServers(): string[] {
  return Object.entries(MCP_BINARIES)
    .filter(([, bin]) => resolveBinary(bin) === null)
    .map(([name]) => name)
}

type McpTarget = 'code' | 'desktop' | 'both'

function detectClaudeDesktopConfigDir(): string | null {
  // One source of truth for where each harness lives (this list had no
  // Windows entry, so Claude Desktop was never configured there).
  const desktop = harnessConfigs(homeDir(), process.platform, process.env).find((h) => h.name === 'claude-desktop')!
  const paths = [desktop.detect, join(homeDir(), '.config', 'claude')]
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
    const added = addMissingServers(servers)
    if (added.length) {
      config.mcpServers = servers
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Claude Desktop configured ${c.dim}(${added.join(', ')})${c.reset}`)
      result.updated.push(`MCP configured for Claude Desktop (${added.join(', ')})`)
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
  const mcpJsonPath = join(DATA_DIR(), '.mcp.json')
  try {
    let config: Record<string, unknown> = {}
    if (existsSync(mcpJsonPath)) {
      config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'))
    }

    const servers = (config.mcpServers || {}) as Record<string, unknown>
    const added = addMissingServers(servers)
    if (added.length) {
      config.mcpServers = servers
      writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + '\n')
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Claude Code configured ${c.dim}(${added.join(', ')})${c.reset}`)
      result.updated.push(`MCP configured for Claude Code (${added.join(', ')})`)
    } else {
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Claude Code ${c.dim}(already configured)${c.reset}`)
      result.alreadyCurrent.push('MCP: Claude Code')
    }

    // Configure permissions so users don't need bypass mode
    configureCodePermissions(isTTY, result)

    return true
  } catch {
    result.warnings.push('Could not configure MCP for Claude Code')
    return false
  }
}

/**
 * Configure Claude Code permissions in .claude/settings.local.json.
 * Enables MCP servers and adds mcp__datacore to the allow list so
 * users don't need to run in bypass mode or approve every tool call.
 */
function configureCodePermissions(isTTY: boolean, result: UpdateResult): void {
  const claudeDir = join(DATA_DIR(), '.claude')
  const settingsPath = join(claudeDir, 'settings.local.json')

  try {
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true })
    }

    let config: Record<string, unknown> = {}
    if (existsSync(settingsPath)) {
      config = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    }

    let changed = false

    // Ensure enableAllProjectMcpServers is set
    if (!config.enableAllProjectMcpServers) {
      config.enableAllProjectMcpServers = true
      changed = true
    }

    // Ensure mcp__datacore is in the allow list
    const permissions = (config.permissions || {}) as Record<string, unknown>
    const allow = (permissions.allow || []) as string[]
    if (!allow.includes('mcp__datacore')) {
      allow.push('mcp__datacore')
      permissions.allow = allow
      config.permissions = permissions
      changed = true
    }

    if (changed) {
      writeFileSync(settingsPath, JSON.stringify(config, null, 2) + '\n')
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Claude Code permissions configured`)
      result.updated.push('Claude Code permissions configured')
    } else {
      if (isTTY) console.log(`  ${c.green}✓${c.reset} Claude Code permissions ${c.dim}(already configured)${c.reset}`)
      result.alreadyCurrent.push('Claude Code permissions')
    }
  } catch {
    result.warnings.push('Could not configure Claude Code permissions')
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

  // Skip only when NEITHER server is present. Keying this on datacore-mcp
  // alone meant a machine with PLUR installed but datacore-mcp missing
  // skipped configuring both, leaving a working server unregistered.
  if (!commandExists('datacore-mcp') && !commandExists('plur-mcp')) {
    if (isTTY) console.log(`  ${c.dim}○ no MCP servers installed, skipping configuration${c.reset}`)
    if (isTTY) console.log()
    return
  }

  // Check if already configured everywhere
  const mcpJsonPath = join(DATA_DIR(), '.mcp.json')
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
    // Index defensively: choose() returns a number, and an out-of-range answer
    // would make this undefined — which then silently skips BOTH configuration
    // branches below, leaving the user with no MCP configured and no error.
    // Falling back to the recommended option keeps the update path total.
    target = (['code', 'desktop', 'both'] as const)[choice] ?? 'code'
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
  const stateDir = join(DATACORE_DIR(), 'state')
  const envDir = join(DATACORE_DIR(), 'env')

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

  const contextMerge = join(DATACORE_DIR(), 'lib', 'context_merge.py')
  if (!existsSync(contextMerge)) {
    if (isTTY) console.log(`  ${c.dim}○ context_merge.py not found (skipping)${c.reset}`)
    if (isTTY) console.log()
    return
  }

  if (runArgs('python3', [contextMerge, 'rebuild', '--path', DATA_DIR(), '--all', '--emit'])) {
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

  if (!existsSync(DATACORE_DIR())) {
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

  // Step 3: Dependencies (MCP server, .datacore/venv, module tool runtime)
  if (!skipDeps) {
    upgradeDependencies(platform, isTTY, result)
    // Installed is not the same as current: upgrade the servers when npm is ahead.
    const mcp = await upgradeMcpPackages((bin) => commandExists(bin) ? getVersionString(bin, '--version') : undefined, isTTY)
    for (const u of mcp.upgraded) result.updated.push(u)
    for (const f of mcp.failed) result.warnings.push(`Could not upgrade ${f}`)
    const venv = ensureDatacoreVenv(DATA_DIR())
    // An error, not a warning: without it the MCP server cannot start.
    if (venv.python) result.updated.push('Python dependencies (.datacore/venv)')
    else result.errors.push(...venv.warnings)
    const moduleWarnings = ensureModuleDeps(DATA_DIR())
    result.warnings.push(...moduleWarnings)
    if (moduleWarnings.length === 0) result.updated.push('Module tool runtime (.datacore/modules)')
  }

  // Step 4: MCP configuration — Claude, then every other installed harness
  await upgradeMcpConfig(isTTY, interactive, result)
  configureOtherHarnesses(isTTY, result)

  // Installs made before 2.3.0 never had core.hooksPath set, so none of the
  // commit and push guards ran for them. Update is the only command they run.
  ensureSafetyHooks(isTTY, result)

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
export { configureMcpForCode, configureMcpForDesktop }
