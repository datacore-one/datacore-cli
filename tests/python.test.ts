import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { findPython, resetPythonCache, classifyVerifyFailure } from '../src/lib/python'

let dir: string
const saved = { PATH: process.env.PATH, DATACORE_PYTHON: process.env.DATACORE_PYTHON }
function fakePython(file: string, version: string, hasYaml: boolean) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `#!/bin/sh\ncase "$*" in *yaml*) ${hasYaml ? '' : 'exit 1;;'} esac\necho ${version}\n`)
  chmodSync(file, 0o755)
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dc-cli-py-')); resetPythonCache(); delete process.env.DATACORE_PYTHON })
afterEach(() => { process.env.PATH = saved.PATH; if (saved.DATACORE_PYTHON === undefined) delete process.env.DATACORE_PYTHON; else process.env.DATACORE_PYTHON = saved.DATACORE_PYTHON; resetPythonCache() })

describe('findPython', () => {
  it('skips an interpreter that cannot import yaml', () => {
    // Bun resolves bare command names against the PATH it started with, so the
    // fakes are addressed by absolute path: a yaml-less DATACORE_PYTHON must be
    // passed over for the venv rather than returned.
    const noYaml = join(dir, 'bin', 'python-noyaml')
    fakePython(noYaml, '3.13', false)
    const venv = join(dir, 'Data', '.datacore', 'venv', 'bin', 'python')
    fakePython(venv, '3.12', true)
    process.env.DATACORE_PYTHON = noYaml
    expect(findPython(join(dir, 'Data'))).toBe(venv)
  })
  it("prefers the installation's venv", () => {
    const venv = join(dir, 'Data', '.datacore', 'venv', 'bin', 'python')
    fakePython(venv, '3.12', true)
    fakePython(join(dir, 'bin', 'python3.13'), '3.13', true)
    process.env.PATH = join(dir, 'bin')
    expect(findPython(join(dir, 'Data'))).toBe(venv)
  })
})

describe('classifyVerifyFailure', () => {
  it('a verifier that crashed on import is unverifiable, not broken', () => {
    expect(classifyVerifyFailure({ status: 1, stderr: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'yaml'" })).toBe('unverifiable')
  })
  it('a clean non-zero verdict is broken', () => {
    expect(classifyVerifyFailure({ status: 1, stderr: 'tris.jsonl: line 6: hash mismatch' })).toBe('broken')
  })
  it('a spawn failure is unverifiable', () => {
    expect(classifyVerifyFailure({ message: 'spawn ENOENT' })).toBe('unverifiable')
  })
})
