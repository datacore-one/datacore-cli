import { describe, it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureDatacoreVenv, ensureModuleDeps, venvPython } from '../src/lib/python-env'

function fixture(): string {
  const d = mkdtempSync(join(tmpdir(), 'dc-venv-'))
  mkdirSync(join(d, '.datacore', 'lib'), { recursive: true })
  writeFileSync(join(d, '.datacore', 'lib', 'requirements.txt'), 'pyyaml>=6.0\n')
  return d
}

describe('ensureDatacoreVenv', () => {
  it('creates the venv with system site packages, then installs core requirements into it', () => {
    const d = fixture()
    const calls: string[][] = []
    const run = (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { ok: true } }
    const r = ensureDatacoreVenv(d, run)
    expect(calls[0]).toEqual(['python3', '-m', 'venv', '--system-site-packages', join(d, '.datacore', 'venv')])
    expect(calls[1]).toEqual([venvPython(d), '-m', 'pip', 'install', '--quiet', '-r', join(d, '.datacore', 'lib', 'requirements.txt')])
    expect(r.python).toBe(venvPython(d))
    expect(r.warnings).toEqual([])
  })
  it('reports a pip failure as a warning and returns no interpreter', () => {
    const d = fixture()
    const run = (_cmd: string, args: string[]) => args.includes('pip') ? { ok: false, stderr: 'boom' } : { ok: true }
    const r = ensureDatacoreVenv(d, run)
    expect(r.python).toBeNull()
    expect(r.warnings[0]).toContain('core Python dependencies')
    expect(r.warnings[0]).toContain('boom')
  })
})

describe('ensureModuleDeps', () => {
  it('installs the shared module runtime so module tools can load', () => {
    const d = fixture()
    mkdirSync(join(d, '.datacore', 'modules'), { recursive: true })
    writeFileSync(join(d, '.datacore', 'modules', 'package.json'), '{"dependencies":{}}')
    const calls: { cmd: string[]; cwd?: string }[] = []
    const run = (cmd: string, args: string[], opts?: { cwd?: string }) => { calls.push({ cmd: [cmd, ...args], cwd: opts?.cwd }); return { ok: true } }
    expect(ensureModuleDeps(d, run)).toEqual([])
    expect(calls[0].cmd).toEqual(['npm', 'install', '--omit=dev', '--no-audit', '--no-fund'])
    expect(calls[0].cwd).toBe(join(d, '.datacore', 'modules'))
  })
  it('warns, naming the consequence, when the install fails', () => {
    const d = fixture()
    mkdirSync(join(d, '.datacore', 'modules'), { recursive: true })
    writeFileSync(join(d, '.datacore', 'modules', 'package.json'), '{}')
    const w = ensureModuleDeps(d, () => ({ ok: false, stderr: 'ENOTFOUND' }))
    expect(w[0]).toContain('module tools will not load')
    expect(w[0]).toContain('ENOTFOUND')
  })
  it('does nothing when there is no modules package.json', () => {
    expect(ensureModuleDeps(fixture(), () => { throw new Error('should not run') })).toEqual([])
  })
})
