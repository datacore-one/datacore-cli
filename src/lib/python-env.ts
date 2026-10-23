/**
 * Datacore's Python and Node module dependencies, installed where they work.
 *
 * Homebrew Python refuses system-wide pip (PEP 668), so the Python
 * dependencies live in .datacore/venv -- the location venv_bootstrap.py,
 * host_deps.py and the MCP server's interpreter selection already expect.
 * --system-site-packages keeps anything the user already has importable.
 *
 * Module tools import @datacore-one/mcp/runtime, resolved from
 * .datacore/modules/node_modules. That directory is gitignored, so without an
 * install every module's tools fail to load and the server quietly offers 12
 * tools instead of 45+.
 */
import { execFileSync } from './exec'
import { existsSync, rmSync, readFileSync, writeFileSync, statSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export type Runner = (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => { ok: boolean; stderr?: string }

const defaultRun: Runner = (cmd, args, opts) => {
  try {
    execFileSync(cmd, args, { stdio: 'pipe', cwd: opts?.cwd, timeout: opts?.timeout })
    return { ok: true }
  } catch (err) {
    return { ok: false, stderr: (err as { stderr?: Buffer | string })?.stderr?.toString().trim() || '' }
  }
}

export function venvPython(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  // Windows venvs put the interpreter in Scripts\, not bin/.
  return platform === 'win32'
    ? join(dataDir, '.datacore', 'venv', 'Scripts', 'python.exe')
    : join(dataDir, '.datacore', 'venv', 'bin', 'python')
}

export function pipInstallInto(python: string, requirements: string, run: Runner = defaultRun) {
  return run(python, ['-m', 'pip', 'install', '--quiet', '-r', requirements], { timeout: 300000 })
}

export type VersionOf = (bin: string) => [number, number] | null

const defaultVersionOf: VersionOf = (bin) => {
  try {
    const out = execFileSync(bin, ['-c', 'import sys;print("%d.%d" % sys.version_info[:2])'],
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    const m = /^(\d+)\.(\d+)$/.exec(out)
    return m ? [Number(m[1]), Number(m[2])] : null
  } catch {
    return null
  }
}

const atLeast310 = (v: [number, number] | null) => !!v && (v[0] > 3 || (v[0] === 3 && v[1] >= 10))

/**
 * The venv's base interpreter must be >= 3.10: Datacore's libraries use PEP-604
 * unions at import time. Bare `python3` is 3.9 on a stock Mac, and a venv built
 * from it would fail every call -- and, existing, never be rebuilt.
 */
const BASE_CANDIDATES = ['python3.13', 'python3.12', 'python3.11', 'python3.10',
  '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3']

export function ensureDatacoreVenv(dataDir: string, run: Runner = defaultRun,
  versionOf: VersionOf = defaultVersionOf): { python: string | null; warnings: string[] } {
  const venvDir = join(dataDir, '.datacore', 'venv')
  const python = venvPython(dataDir)
  if (existsSync(python) && !atLeast310(versionOf(python))) {
    rmSync(venvDir, { recursive: true, force: true })
  }
  if (!existsSync(python)) {
    const base = BASE_CANDIDATES.find(bin => atLeast310(versionOf(bin)))
    if (!base) {
      return { python: null, warnings: [`Could not create ${venvDir}: no Python >= 3.10 found. Install one (e.g. brew install python@3.12), then run: datacore update`] }
    }
    const made = run(base, ['-m', 'venv', '--system-site-packages', venvDir], { timeout: 120000 })
    if (!made.ok) {
      const hint = /ensurepip|venv/i.test(made.stderr ?? '')
        ? ` Fix: ${venvInstallHint(process.platform, versionOf(base), readOsRelease())}, then run: datacore update` : ''
      return { python: null, warnings: [`Could not create ${venvDir} with ${base}: ${made.stderr ?? ''}`.trim() + hint] }
    }
  }
  const req = join(dataDir, '.datacore', 'lib', 'requirements.txt')
  if (existsSync(req)) {
    const pip = pipInstallInto(python, req, run)
    if (!pip.ok) return { python: null, warnings: [`Installing core Python dependencies into ${venvDir} failed: ${pip.stderr ?? ''}`.trim()] }
  }
  return { python, warnings: [] }
}

export function ensureModuleDeps(dataDir: string, run: Runner = defaultRun): string[] {
  const modulesDir = join(dataDir, '.datacore', 'modules')
  const pkg = join(modulesDir, 'package.json')
  if (!existsSync(pkg)) return []
  const lock = join(modulesDir, 'package-lock.json')
  const hasLock = existsSync(lock)

  // Nothing changed since the last install: skip it (and its network round).
  // npm writes node_modules/.package-lock.json on every install.
  const hidden = join(modulesDir, 'node_modules', '.package-lock.json')
  try {
    if (existsSync(hidden)) {
      const installed = statSync(hidden).mtimeMs
      if (installed >= statSync(pkg).mtimeMs && (!hasLock || installed >= statSync(lock).mtimeMs)) return []
    }
  } catch { /* fall through to an install */ }

  // The lock file is TRACKED by the root repo. `npm install` rewrote it on
  // every update, leaving the root dirty, which then blocks the next merge
  // from upstream. `npm ci` installs from the lock and never writes it; and
  // whatever runs, the lock is put back byte for byte.
  const before = hasLock ? readFileSync(lock) : null
  // --ignore-scripts: module tools import only @datacore-one/mcp/runtime (zod,
  // js-yaml, interpreter selection). The package's native sqlite build is never
  // loaded from here, and a host without a prebuilt binary or toolchain would
  // otherwise fail the whole install and lose every module tool.
  const flags = ['--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']
  let r = hasLock ? run('npm', ['ci', ...flags], { cwd: modulesDir, timeout: 300000 }) : { ok: false }
  if (!r.ok) r = run('npm', ['install', ...flags], { cwd: modulesDir, timeout: 300000 })
  if (before) {
    try {
      if (!readFileSync(lock).equals(before)) writeFileSync(lock, before)
    } catch { /* a lock we cannot restore is git's to show, not ours to hide */ }
  }
  return r.ok ? [] : [`npm install in ${modulesDir} failed, so module tools will not load: ${r.stderr ?? ''}`.trim()]
}

/**
 * The command that makes `python3 -m venv` work on this machine.
 *
 * Debian and Ubuntu split venv's ensurepip into a separate package named after
 * the exact Python version (python3.12-venv on Ubuntu 24.04); without it
 * `python3 -m venv` fails and Datacore's MCP server cannot start.
 */
export function venvInstallHint(platform: NodeJS.Platform, version: [number, number] | null, osRelease = ''): string {
  const v = version ? `${version[0]}.${version[1]}` : '3'
  if (platform === 'darwin') return `brew install python@${version && version[1] >= 10 ? v : '3.12'}`
  if (platform === 'win32') return 'winget install --id Python.Python.3.12 --exact'
  if (/^(ID|ID_LIKE)=.*\b(debian|ubuntu)\b/m.test(osRelease)) {
    return version && version[1] >= 10 ? `sudo apt install python${v}-venv` : 'sudo apt install python3 python3-venv'
  }
  return `install Python >= 3.10 with its venv module (your distribution's python${v === '3' ? '3' : v}-venv or python3 package)`
}

function readOsRelease(): string {
  try { return readFileSync('/etc/os-release', 'utf-8') } catch { return '' }
}

/**
 * Can this machine build Datacore's virtual environment? Checked by init
 * BEFORE anything relies on it, by building a throwaway venv the same way
 * ensureDatacoreVenv will (with pip: missing ensurepip is the usual failure,
 * and `import venv` alone succeeds without it).
 */
export function checkVenvSupport(run: Runner = defaultRun, versionOf: VersionOf = defaultVersionOf,
  platform: NodeJS.Platform = process.platform, osRelease: string = readOsRelease()):
  { ok: boolean; python?: string; version?: [number, number]; error?: string; fix?: string } {
  const base = BASE_CANDIDATES.find(bin => atLeast310(versionOf(bin)))
  if (!base) {
    return { ok: false, error: 'no Python >= 3.10 found', fix: venvInstallHint(platform, null, osRelease) }
  }
  const version = versionOf(base) ?? undefined
  let probe = ''
  try {
    probe = mkdtempSync(join(tmpdir(), 'datacore-venv-check-'))
    const made = run(base, ['-m', 'venv', join(probe, 'venv')], { timeout: 120000 })
    if (made.ok) return { ok: true, python: base, version }
    return {
      ok: false, python: base, version,
      error: (made.stderr || 'python -m venv failed').split('\n').find(l => l.trim()) ?? 'python -m venv failed',
      fix: venvInstallHint(platform, version ?? null, osRelease),
    }
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true })
  }
}

/**
 * Whether `datacore init` succeeded. Errors count: a failed core Python install
 * was pushed to `errors` while success was computed from the other two lists,
 * so init reported success on an installation whose MCP server cannot start.
 */
export function initSucceeded(r: { unresolvable: unknown[]; incomplete: unknown[]; errors: unknown[] }): boolean {
  return r.unresolvable.length === 0 && r.incomplete.length === 0 && r.errors.length === 0
}
