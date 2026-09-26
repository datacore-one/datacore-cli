/**
 * Register Datacore and PLUR with every AI harness on the machine.
 *
 * init wired Claude Code and Claude Desktop only, so a user working in Cursor,
 * Codex or Antigravity finished a clean install with an agent that had no
 * datacore_* or plur_* tools — and no error anywhere to say so.
 *
 * Rules, the same ones the Claude writers in upgrade.ts follow:
 *   - a harness is configured only if it is already installed (its config
 *     directory exists); nothing is installed on the user's behalf;
 *   - servers are ADDED when missing and never overwritten, so a user's own
 *     entry wins;
 *   - a config that does not parse is refused, never replaced.
 *
 * Cursor goes through .datacore/adapters/cursor/install.py, which owns the
 * Cursor-specific parts (the ~40-tool cap, tool profiles, hooks) and writes a
 * workspace config for ~/Data.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { execFileSync, homeDir } from './exec'
import { findPython } from './python'

export interface McpEntry {
  command: string
  args?: string[]
}

export interface HarnessConfig {
  name: string
  label: string
  /** The config file to write. */
  path: string
  /** Present only when the harness is installed. */
  detect: string
  format: 'json' | 'toml'
}

export function harnessConfigs(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): HarnessConfig[] {
  const desktopDir = platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Claude')
    : platform === 'win32'
      ? join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude')
      : join(home, '.config', 'Claude')
  return [
    { name: 'claude-desktop', label: 'Claude Desktop', path: join(desktopDir, 'claude_desktop_config.json'), detect: desktopDir, format: 'json' },
    { name: 'codex', label: 'Codex', path: join(home, '.codex', 'config.toml'), detect: join(home, '.codex'), format: 'toml' },
    { name: 'antigravity', label: 'Antigravity', path: join(home, '.gemini', 'config', 'mcp_config.json'), detect: join(home, '.gemini', 'config'), format: 'json' },
    { name: 'gemini-cli', label: 'Gemini CLI', path: join(home, '.gemini', 'settings.json'), detect: join(home, '.gemini', 'settings.json'), format: 'json' },
    { name: 'windsurf', label: 'Windsurf', path: join(home, '.codeium', 'windsurf', 'mcp_config.json'), detect: join(home, '.codeium', 'windsurf'), format: 'json' },
  ]
}

/** Add missing servers under `mcpServers`. Throws on a config that does not parse. */
export function addServersJson(text: string | null, servers: Record<string, McpEntry>): { text: string; added: string[] } {
  const config = (text && text.trim() ? JSON.parse(text) : {}) as Record<string, unknown>
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error('config is not a JSON object')
  const existing = (config.mcpServers ?? {}) as Record<string, unknown>
  const added: string[] = []
  for (const [name, entry] of Object.entries(servers)) {
    if (!existing[name]) {
      existing[name] = entry
      added.push(name)
    }
  }
  config.mcpServers = existing
  return { text: JSON.stringify(config, null, 2) + '\n', added }
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Append a `[mcp_servers.<name>]` table per missing server; the rest is kept byte for byte. */
export function addServersToml(text: string | null, servers: Record<string, McpEntry>): { text: string; added: string[] } {
  let out = text ?? ''
  const added: string[] = []
  for (const [name, entry] of Object.entries(servers)) {
    const header = new RegExp(`^\\[mcp_servers\\.(${name}|"${name}")\\]\\s*$`, 'm')
    if (header.test(out)) continue
    if (out && !out.endsWith('\n')) out += '\n'
    if (out) out += '\n'
    out += `[mcp_servers.${name}]\ncommand = ${tomlString(entry.command)}\n`
    if (entry.args?.length) out += `args = [${entry.args.map(tomlString).join(', ')}]\n`
    added.push(name)
  }
  return { text: out, added }
}

/**
 * On Windows an npm "binary" is a .cmd shim, and most MCP clients spawn
 * without a shell, which Node refuses for .cmd files. So the entry runs node
 * on the package's script directly.
 */
export function windowsMcpEntry(nodePath: string, script: string): McpEntry {
  return { command: nodePath, args: [script] }
}

/** The script a .cmd shim would run: <prefix>\node_modules\<pkg>\<bin>. */
export function windowsScriptFor(npmPrefix: string, pkg: string, bin: string): string | null {
  try {
    const pkgDir = join(npmPrefix, 'node_modules', ...pkg.split('/'))
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8')) as { bin?: string | Record<string, string> }
    const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[bin]
    return rel ? join(pkgDir, rel) : null
  } catch {
    return null
  }
}

export interface WireResult {
  configured: string[]
  alreadyCurrent: string[]
  warnings: string[]
}

/**
 * Write `servers` into every installed harness. `servers` comes from the same
 * builder the Claude Code config uses, so every harness launches the same
 * binaries.
 */
export function wireHarnesses(servers: Record<string, McpEntry>, dataDir: string, opts: {
  home?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  cursorAdapter?: boolean
  /** Harnesses configured elsewhere (Claude Desktop has its own flow in upgrade.ts). */
  skip?: string[]
} = {}): WireResult {
  const home = opts.home ?? homeDir()
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const res: WireResult = { configured: [], alreadyCurrent: [], warnings: [] }

  for (const h of harnessConfigs(home, platform, env)) {
    if (opts.skip?.includes(h.name) || !existsSync(h.detect)) continue
    try {
      const before = existsSync(h.path) ? readFileSync(h.path, 'utf-8') : null
      const r = h.format === 'toml' ? addServersToml(before, servers) : addServersJson(before, servers)
      if (r.added.length === 0) {
        res.alreadyCurrent.push(h.label)
        continue
      }
      mkdirSync(dirname(h.path), { recursive: true })
      writeFileSync(h.path, r.text)
      res.configured.push(`${h.label} (${r.added.join(', ')})`)
    } catch (e) {
      res.warnings.push(`${h.label}: ${h.path} could not be read as ${h.format.toUpperCase()} — left untouched (${(e as Error).message})`)
    }
  }

  if (opts.cursorAdapter !== false) {
    const cursor = wireCursor(home, dataDir)
    if (cursor) (cursor.ok ? res.configured : res.warnings).push(cursor.message)
  }
  return res
}

/** Cursor, through the adapter that knows its limits. Null when Cursor is absent. */
function wireCursor(home: string, dataDir: string): { ok: boolean; message: string } | null {
  if (!existsSync(join(home, '.cursor'))) return null
  const adapter = join(dataDir, '.datacore', 'adapters', 'cursor', 'install.py')
  if (!existsSync(adapter)) {
    return { ok: false, message: 'Cursor: this installation predates the Cursor adapter — run `datacore update`, then `datacore init` again' }
  }
  const python = findPython(dataDir)
  if (!python) return { ok: false, message: 'Cursor: no Python 3.10+ found to run the Cursor adapter' }
  try {
    execFileSync(python, [adapter, 'install', '--root', dataDir], { cwd: dataDir, stdio: 'pipe', timeout: 60000 })
    return { ok: true, message: `Cursor (open ${dataDir} as the workspace)` }
  } catch (e) {
    const err = String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim().split('\n').pop()
    return { ok: false, message: `Cursor adapter failed: ${err}` }
  }
}
