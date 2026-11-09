/**
 * Second-machine setup, the non-git half: what init checks before it relies on
 * Python, how it takes a snapshot instead of creating template spaces, what
 * doctor says on a headless Linux server, and what `space --help` offers.
 *
 * From a real headless Ubuntu 24.04 install (2026-10-23): init went ahead
 * without python3.12-venv so the MCP server could not start; init created a
 * template 0-personal that then made `snapshot restore` skip the real one;
 * doctor flagged a missing Claude Desktop config on a machine where Claude
 * Desktop does not exist and ended "Missing recommended dependencies" with
 * every dependency present; `space --help` promised a join it did not list.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkVenvSupport, venvInstallHint } from '../src/lib/python-env'
import { checkMcpConfig, doctorVerdict } from '../src/lib/dependency'
import { personalSpacePlan, snapshotCloneUrls, SECOND_MACHINE_HELP, initDatacore } from '../src/lib/init'
import { ACTIONS, parseArgs } from '../src/routing'
import { showResourceHelp } from '../src/help'
import type { Snapshot } from '../src/lib/snapshot'

const dirs: string[] = []
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

const UBUNTU = 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\n'

// ─── 4. venv ────────────────────────────────────────────────────────────────

describe('init checks that Python can create a virtual environment', () => {
  it('passes when `python -m venv` works', () => {
    const r = checkVenvSupport((_c, _a) => ({ ok: true }), () => [3, 12], 'linux', UBUNTU)
    expect(r.ok).toBe(true)
    expect(r.python).toBe('python3.13')
  })

  it('names the exact apt package on Ubuntu when ensurepip is missing', () => {
    const run = () => ({ ok: false, stderr: 'The virtual environment was not created successfully because ensurepip is not available.' })
    const r = checkVenvSupport(run, () => [3, 12], 'linux', UBUNTU)
    expect(r.ok).toBe(false)
    expect(r.fix).toBe('sudo apt install python3.12-venv')
  })

  it('actually builds a venv to test (ensurepip is what fails, not the venv module import)', () => {
    const calls: string[][] = []
    checkVenvSupport((c, a) => { calls.push([c, ...a]); return { ok: true } }, () => [3, 12], 'linux', UBUNTU)
    expect(calls[0]!.slice(0, 3)).toEqual(['python3.13', '-m', 'venv'])
    expect(calls[0]).not.toContain('--without-pip')
  })

  it('install hints per platform', () => {
    expect(venvInstallHint('linux', [3, 11], 'ID=debian\n')).toBe('sudo apt install python3.11-venv')
    expect(venvInstallHint('darwin', [3, 12])).toContain('brew install python@3.12')
    expect(venvInstallHint('linux', [3, 12], 'ID=fedora\n')).toContain('venv')
  })

  it('reports no Python >= 3.10 with an install command, not a crash', () => {
    const r = checkVenvSupport(() => ({ ok: true }), () => [3, 8], 'linux', UBUNTU)
    expect(r.ok).toBe(false)
    expect(r.fix).toContain('apt')
  })
})

// ─── 5. init --from-snapshot ────────────────────────────────────────────────

const snap = (spaces: Snapshot['spaces'], root?: Snapshot['root']): Snapshot => ({
  version: '1.0', created: '', cliVersion: '', platform: '', modules: [], dependencies: [], spaces, root,
})

describe('init from a snapshot never creates a template space the snapshot provides', () => {
  it('creates 0-personal from the template only without a snapshot that has one', () => {
    const d = tmp('dc-init-')
    expect(personalSpacePlan(d, null)).toBe('create')
    expect(personalSpacePlan(d, snap([{ name: '1-team', number: 1, type: 'team', source: 'x' }]))).toBe('create')
  })

  it('a snapshot that provides 0-personal is never replaced by a template, even if its clone failed', () => {
    const d = tmp('dc-init-')
    const s = snap([{ name: '0-personal', number: 0, type: 'personal', source: 'https://example.com/p.git' }])
    expect(personalSpacePlan(d, s)).toBe('missing-from-snapshot')
    mkdirSync(join(d, '0-personal'))
    expect(personalSpacePlan(d, s)).toBe('exists')
  })

  it('clones the root from where the snapshot says it came from, first', () => {
    const urls = snapshotCloneUrls(snap([], { source: 'https://example.com/me/datacore.git' }),
      ['https://github.com/datacore-one/datacore.git'])
    expect(urls[0]).toBe('https://example.com/me/datacore.git')
    expect(urls).toContain('https://github.com/datacore-one/datacore.git')
  })

  it('refuses an unreadable snapshot before changing anything', async () => {
    const r = await initDatacore({ fromSnapshot: '/nonexistent/datacore.lock.yaml', nonInteractive: true })
    expect(r.success).toBe(false)
    expect(r.errors.join(' ')).toContain('/nonexistent/datacore.lock.yaml')
  })

  it('parses --from-snapshot <file>', () => {
    const p = parseArgs(['init', '--from-snapshot', 'datacore.lock.yaml'])
    expect(p).toMatchObject({ type: 'meta', command: 'init', flags: { 'from-snapshot': 'datacore.lock.yaml' } })
  })

  it('tells a second-machine user both halves of the route', () => {
    const text = SECOND_MACHINE_HELP.join('\n')
    expect(text).toContain('datacore snapshot create --settings')
    expect(text).toContain('datacore init --from-snapshot')
  })
})

// ─── doctor on a headless server ────────────────────────────────────────────

describe('doctor on a machine without Claude Desktop', () => {
  it('does not check Claude Desktop on Linux', () => {
    const home = tmp('dc-home-')
    // Even a stray ~/.config/Claude must not turn the row back on: there is no Linux app.
    mkdirSync(join(home, '.config', 'Claude'), { recursive: true })
    expect(checkMcpConfig({ home, platform: 'linux', dataDir: join(home, 'Data') }).claudeDesktop).toBeNull()
  })

  it('does not check it on a Mac without the app either', () => {
    const home = tmp('dc-home-')
    expect(checkMcpConfig({ home, platform: 'darwin', dataDir: join(home, 'Data') }).claudeDesktop).toBeNull()
  })

  it('still checks it where the app is installed', () => {
    const home = tmp('dc-home-')
    const dir = join(home, 'Library', 'Application Support', 'Claude')
    mkdirSync(dir, { recursive: true })
    expect(checkMcpConfig({ home, platform: 'darwin', dataDir: join(home, 'Data') }).claudeDesktop).toBe(false)
    writeFileSync(join(dir, 'claude_desktop_config.json'), '{"mcpServers":{"datacore":{}}}')
    expect(checkMcpConfig({ home, platform: 'darwin', dataDir: join(home, 'Data') }).claudeDesktop).toBe(true)
  })

  it('reads .mcp.json from the data dir, not a hardcoded ~/Data', () => {
    const home = tmp('dc-home-')
    const data = join(home, 'elsewhere')
    mkdirSync(data)
    writeFileSync(join(data, '.mcp.json'), '{"mcpServers":{"datacore":{}}}')
    expect(checkMcpConfig({ home, platform: 'linux', dataDir: data }).claudeCode).toBe(true)
  })

  it('says "missing recommended dependencies" only when one is missing', () => {
    expect(doctorVerdict('ready').level).toBe('ok')
    expect(doctorVerdict('missing_recommended').message).toContain('recommended')
    expect(doctorVerdict('ledger_degraded').message).not.toContain('dependencies')
    expect(doctorVerdict('missing_required').level).toBe('error')
  })
})

// ─── 6. space --help ────────────────────────────────────────────────────────

describe('space actions match the help text', () => {
  it('lists join (it exists) and audit', () => {
    expect(ACTIONS.space).toContain('join')
    expect(ACTIONS.space).toContain('audit')
  })
  it('space --help lists join and points a second machine to the snapshot route', () => {
    const lines: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')) }
    try { showResourceHelp('space'); showResourceHelp('init') } finally { console.log = orig }
    const text = lines.join('\n')
    expect(text).toMatch(/\n  join\s/)
    expect(text).toContain('--from-snapshot')
    expect(text).toContain('snapshot create --settings')
  })
})
