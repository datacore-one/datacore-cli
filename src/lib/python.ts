/**
 * Find a Python that can actually run Datacore's libraries.
 *
 * `python3` is NOT good enough on macOS. The system interpreter at
 * /usr/bin/python3 is 3.9, and Datacore's ledger code uses PEP-604 unions
 * (`str | None`) at import time, so it does not fail gracefully — it raises
 *
 *     TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'
 *
 * before running a single line. A caller that shells out to bare `python3`
 * therefore gets a hard failure on the most common developer machine in the
 * fleet, and — worse — a caller that treats that failure as "the transport is
 * unavailable" silently falls back to the very behaviour it was replacing.
 * That is not hypothetical: the same 3.9-vs-3.11 mismatch already broke the
 * daily ledger job, which now pins /opt/homebrew/bin/python3 by hand.
 *
 * So resolve by CAPABILITY, not by name: ask each candidate its version and
 * take the first that clears the floor.
 */

import { execFileSync } from 'child_process'

/** Datacore libraries use PEP-604 unions, which require 3.10. */
const MIN_MAJOR = 3
const MIN_MINOR = 10

let cached: string | null | undefined

/**
 * Candidates in preference order. DATACORE_PYTHON wins outright so an operator
 * can point at a venv or pyenv shim without editing code — the MCP server
 * already uses that variable name, and diverging would mean one installation
 * needing two different answers to the same question.
 */
function candidates(): string[] {
  const list: string[] = []
  const explicit = process.env.DATACORE_PYTHON
  if (explicit) list.push(explicit)
  // Version-qualified names first: they cannot be the 3.9 system binary.
  list.push('python3.13', 'python3.12', 'python3.11', 'python3.10')
  // Homebrew's is the real interpreter on most Macs, and is NOT first on PATH
  // for non-interactive shells — which is how a launchd job ends up on 3.9.
  list.push('/opt/homebrew/bin/python3', '/usr/local/bin/python3')
  list.push('python3')
  return list
}

function versionOf(bin: string): [number, number] | null {
  try {
    const out = execFileSync(
      bin,
      ['-c', 'import sys;print("%d.%d" % sys.version_info[:2])'],
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim()
    const parts = out.split('.').map(Number)
    const maj = parts[0]
    const min = parts[1]
    if (maj !== undefined && min !== undefined && Number.isFinite(maj) && Number.isFinite(min)) {
      return [maj, min]
    }
    return null
  } catch {
    return null // not installed, or not executable — try the next one
  }
}

/**
 * The first interpreter on this machine that can run Datacore's libraries,
 * or null if there is none. Null is a real answer, not an error: the caller
 * decides what degraded behaviour is safe.
 */
export function findPython(): string | null {
  if (cached !== undefined) return cached
  for (const bin of candidates()) {
    const v = versionOf(bin)
    if (v && (v[0] > MIN_MAJOR || (v[0] === MIN_MAJOR && v[1] >= MIN_MINOR))) {
      cached = bin
      return cached
    }
  }
  cached = null
  return cached
}

/** Test seam — resolution is cached because probing spawns processes. */
export function resetPythonCache(): void {
  cached = undefined
}

export const PYTHON_MIN_VERSION = `${MIN_MAJOR}.${MIN_MINOR}`
