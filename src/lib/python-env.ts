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
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

export type Runner = (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => { ok: boolean; stderr?: string }

const defaultRun: Runner = (cmd, args, opts) => {
  try {
    execFileSync(cmd, args, { stdio: 'pipe', cwd: opts?.cwd, timeout: opts?.timeout })
    return { ok: true }
  } catch (err) {
    return { ok: false, stderr: (err as { stderr?: Buffer | string })?.stderr?.toString().trim() || '' }
  }
}

export function venvPython(dataDir: string): string {
  return join(dataDir, '.datacore', 'venv', 'bin', 'python')
}

export function pipInstallInto(python: string, requirements: string, run: Runner = defaultRun) {
  return run(python, ['-m', 'pip', 'install', '--quiet', '-r', requirements], { timeout: 300000 })
}

export function ensureDatacoreVenv(dataDir: string, run: Runner = defaultRun): { python: string | null; warnings: string[] } {
  const venvDir = join(dataDir, '.datacore', 'venv')
  const python = venvPython(dataDir)
  if (!existsSync(python)) {
    const made = run('python3', ['-m', 'venv', '--system-site-packages', venvDir], { timeout: 120000 })
    if (!made.ok) return { python: null, warnings: [`Could not create ${venvDir}: ${made.stderr ?? ''}`.trim()] }
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
  if (!existsSync(join(modulesDir, 'package.json'))) return []
  const r = run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: modulesDir, timeout: 300000 })
  return r.ok ? [] : [`npm install in ${modulesDir} failed, so module tools will not load: ${r.stderr ?? ''}`.trim()]
}
