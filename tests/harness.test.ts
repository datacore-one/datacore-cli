/**
 * Datacore in every harness on the machine, not only Claude.
 *
 * init registered the MCP servers with Claude Code and Claude Desktop and
 * nothing else, so a Cursor user got a working install and an agent with no
 * datacore_* or plur_* tools. The merge functions are pure so every format is
 * tested without touching the developer's real configs.
 */
import { describe, it, expect } from 'bun:test'
import { join } from 'path'
import { addServersJson, addServersToml, harnessConfigs, windowsMcpEntry } from '../src/lib/harness'

const servers = {
  datacore: { command: '/usr/local/bin/datacore-mcp' },
  plur: { command: '/usr/local/bin/plur-mcp' },
}

describe('JSON configs (Claude Desktop, Antigravity, Gemini CLI, Windsurf)', () => {
  it('creates the file content when there is none', () => {
    const r = addServersJson(null, servers)
    expect(r.added).toEqual(['datacore', 'plur'])
    expect(JSON.parse(r.text).mcpServers.datacore.command).toBe('/usr/local/bin/datacore-mcp')
  })
  it('keeps every other key and server, and never overwrites an existing entry', () => {
    const before = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' }, plur: { command: 'mine' } } })
    const r = addServersJson(before, servers)
    const d = JSON.parse(r.text)
    expect(r.added).toEqual(['datacore'])
    expect(d.theme).toBe('dark')
    expect(d.mcpServers.other.command).toBe('x')
    expect(d.mcpServers.plur.command).toBe('mine')
  })
  it('reports nothing added when both are present', () => {
    const first = addServersJson(null, servers).text
    expect(addServersJson(first, servers).added).toEqual([])
  })
  it('refuses a config that does not parse rather than overwrite it', () => {
    expect(() => addServersJson('{ not json', servers)).toThrow()
  })
})

describe('TOML config (Codex)', () => {
  it('appends a block per missing server and keeps the rest verbatim', () => {
    const before = 'model = "gpt-5.4"\n\n[mcp_servers.plur]\ncommand = "mine"\n'
    const r = addServersToml(before, servers)
    expect(r.added).toEqual(['datacore'])
    expect(r.text.startsWith(before)).toBe(true)
    expect(r.text).toContain('[mcp_servers.datacore]\ncommand = "/usr/local/bin/datacore-mcp"')
    expect(r.text.match(/\[mcp_servers\.plur\]/g)?.length).toBe(1)
  })
  it('escapes Windows paths and writes args', () => {
    const r = addServersToml('', { datacore: { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\npm\\x.js'] } })
    expect(r.text).toContain('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"')
    expect(r.text).toContain('args = ["C:\\\\npm\\\\x.js"]')
  })
  it('is idempotent', () => {
    const once = addServersToml('', servers).text
    expect(addServersToml(once, servers).added).toEqual([])
  })
})

describe('where each harness keeps its config', () => {
  const home = '/home/ana'
  const byName = (p: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) =>
    Object.fromEntries(harnessConfigs(home, p, env).map((h) => [h.name, h.path]))

  it('knows Codex, Antigravity, Gemini CLI and Windsurf', () => {
    const m = byName('linux')
    expect(m['codex']).toBe(join(home, '.codex', 'config.toml'))
    expect(m['antigravity']).toBe(join(home, '.gemini', 'config', 'mcp_config.json'))
    expect(m['gemini-cli']).toBe(join(home, '.gemini', 'settings.json'))
    expect(m['windsurf']).toBe(join(home, '.codeium', 'windsurf', 'mcp_config.json'))
  })
  it('finds Claude Desktop under APPDATA on Windows (it was never looked for there)', () => {
    expect(byName('win32', { APPDATA: 'C:\\Users\\ana\\AppData\\Roaming' })['claude-desktop'])
      .toBe(join('C:\\Users\\ana\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'))
  })
  it('finds Claude Desktop in Application Support on macOS', () => {
    expect(byName('darwin')['claude-desktop'])
      .toBe(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'))
  })
})

describe('Windows MCP entries', () => {
  it('launch node with the package script, since clients cannot spawn npm .cmd shims', () => {
    expect(windowsMcpEntry('C:\\Program Files\\nodejs\\node.exe', 'C:\\npm\\node_modules\\@plur-ai\\mcp\\dist\\index.js'))
      .toEqual({ command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\npm\\node_modules\\@plur-ai\\mcp\\dist\\index.js'] })
  })
})
