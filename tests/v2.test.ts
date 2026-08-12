/**
 * v2 guarantees. Each test here corresponds to a way v1 was actually broken —
 * these are regression locks, not coverage.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { VERSION } from '../src/version'
import { findPython, PYTHON_MIN_VERSION, resetPythonCache } from '../src/lib/python'
import { dataDir } from '../src/lib/paths'

const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf-8'))

describe('version is single-sourced', () => {
  // `datacore --version` printed 1.3.0 while package.json disagreed, and
  // snapshot.ts stamped every lock file with a hardcoded 1.0.6 — three
  // releases stale, inside the artifact whose job is exact reproduction.
  it('VERSION equals package.json', () => {
    expect(VERSION).toBe(pkg.version)
  })

  it('no version string is retyped in src', async () => {
    const { $ } = await import('bun')
    const hits =
      await $`grep -rEn "VERSION *= *'[0-9]+\.[0-9]+\.[0-9]+'" src`.nothrow().text()
    expect(hits.trim()).toBe('')
  })
})

describe('sync never rebases', () => {
  // git pull --rebase on the UPDATE path rewrote unpushed local commits; when
  // the follow-up push failed they survived only under hashes no other machine
  // had seen. 23 commits in 2-datacore and 27 in 3-fds were lost this way on
  // 2026-08-12. Neither converge nor the fallback may reintroduce it.
  // Scoped to sync.ts at first, which missed init.ts doing `pull --rebase
  // --autostash` against an already-populated ~/Data. The publish gate caught
  // it by grepping the built bundle; this widens the source check to match, so
  // it fails in a second rather than at publish time.
  it('no --rebase in any source file', async () => {
    const { $ } = await import('bun')
    const hits = await $`grep -rn -- "--rebase" src`.nothrow().text()
    const code = hits
      .split('\n')
      .filter((l) => l.trim())
      .filter((l) => {
        const body = l.slice(l.indexOf(':', l.indexOf(':') + 1) + 1).trimStart()
        return !body.startsWith('*') && !body.startsWith('//') && !body.startsWith('#')
      })
    expect(code).toEqual([])
  })

  it('never uses --autostash', async () => {
    // A conflicting stash pop keeps the stash AND writes conflict markers into
    // the working tree — that is how org files were corrupted on 2026-08-03.
    const { $ } = await import('bun')
    const hits = await $`grep -rn -- "--autostash" src`.nothrow().text()
    const code = hits.split('\n').filter((l) => l.trim()).filter((l) => {
      const body = l.slice(l.indexOf(':', l.indexOf(':') + 1) + 1).trimStart()
      return !body.startsWith('*') && !body.startsWith('//')
    })
    expect(code).toEqual([])
  })

  it('falls back to an explicit merge pull, not a bare pull', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'sync.ts'), 'utf-8')
    expect(src).toContain("'pull', '--no-rebase'")
  })
})

describe('python resolution', () => {
  // macOS `python3` is 3.9 and raises TypeError loading the ledger's PEP-604
  // annotations. Selecting by name instead of capability silently disabled the
  // transport on every Mac.
  it('never returns an interpreter below the floor', () => {
    resetPythonCache()
    const py = findPython()
    if (py === null) return // legitimate on a box with no modern python
    const { execFileSync } = require('child_process')
    const v = execFileSync(py, ['-c', 'import sys;print("%d.%d" % sys.version_info[:2])'], {
      encoding: 'utf-8',
    }).trim()
    const [maj, min] = v.split('.').map(Number)
    const [fMaj, fMin] = PYTHON_MIN_VERSION.split('.').map(Number)
    expect(maj! > fMaj! || (maj === fMaj && min! >= fMin!)).toBe(true)
  }, 30000)

  it('honours DATACORE_PYTHON', () => {
    const prev = process.env.DATACORE_PYTHON
    resetPythonCache()
    const baseline = findPython()
    if (!baseline) return
    process.env.DATACORE_PYTHON = baseline
    resetPythonCache()
    expect(findPython()).toBe(baseline)
    if (prev === undefined) delete process.env.DATACORE_PYTHON
    else process.env.DATACORE_PYTHON = prev
    resetPythonCache()
    // Probing spawns one process per candidate (up to six) and each may be a
    // PATH miss; two full uncached probes exceed the 5s default.
  }, 30000)
})

describe('installation root is configurable', () => {
  let fixture: string
  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), 'datacore-root-'))
    mkdirSync(join(fixture, '.datacore'), { recursive: true })
  })
  afterAll(() => rmSync(fixture, { recursive: true, force: true }))

  it('DATACORE_ROOT overrides ~/Data', () => {
    const prev = process.env.DATACORE_ROOT
    process.env.DATACORE_ROOT = fixture
    expect(dataDir()).toBe(fixture)
    if (prev === undefined) delete process.env.DATACORE_ROOT
    else process.env.DATACORE_ROOT = prev
  })

  it('falls back to ~/Data when unset', () => {
    const prev = process.env.DATACORE_ROOT
    delete process.env.DATACORE_ROOT
    expect(dataDir()).toBe(join(process.env.HOME!, 'Data'))
    if (prev !== undefined) process.env.DATACORE_ROOT = prev
  })
})

describe('doctor reports the ledger', () => {
  let fixture: string
  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), 'datacore-doctor-'))
    mkdirSync(join(fixture, '.datacore', 'lib'), { recursive: true })
    process.env.DATACORE_ROOT = fixture
  })
  afterAll(() => {
    delete process.env.DATACORE_ROOT
    rmSync(fixture, { recursive: true, force: true })
  })

  it('distinguishes "not present" from "broken"', async () => {
    const { runDoctor } = await import('../src/lib/dependency')
    const r = runDoctor()
    expect(Array.isArray(r.ledger)).toBe(true)
    // A pre-ledger installation must NOT read as a failure — it needs an
    // update, not an incident. ok:null is what carries that difference.
    const ledgerCheck = r.ledger!.find((c) => c.name === 'ledger')
    if (ledgerCheck) expect(ledgerCheck.ok).toBeNull()
    expect(r.status).not.toBe('ledger_degraded')
  }, 30000)

  it('reports the resolved data dir so probes cannot guess wrong', async () => {
    const { runDoctor } = await import('../src/lib/dependency')
    expect(runDoctor().dataDir).toBe(fixture)
  }, 30000)

  it('flags a broken hash chain as degraded', async () => {
    // Plant a ledger_cli.py that always fails, and a space with an events dir.
    writeFileSync(
      join(fixture, '.datacore', 'lib', 'ledger_cli.py'),
      'import sys\nsys.exit(3)\n',
    )
    mkdirSync(join(fixture, '0-personal', '.datacore', 'events'), { recursive: true })
    const { runDoctor } = await import('../src/lib/dependency')
    const r = runDoctor()
    const chains = r.ledger!.find((c) => c.name === 'chains')
    if (findPython() === null) return // cannot run the probe at all
    expect(chains?.ok).toBe(false)
    expect(r.status).toBe('ledger_degraded')
  }, 60000)
})
