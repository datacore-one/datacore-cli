/**
 * The CLI's version — read from package.json, never retyped.
 *
 * It was retyped, in at least two places, and they drifted: `datacore --version`
 * reported 1.3.0 while package.json said something else (fixed by hand in
 * 10ceecd, "bump version to 1.3.0 (matches src/index.ts VERSION constant)"),
 * and snapshot.ts still stamped every lock file it wrote with a hardcoded
 * "1.0.6" — three releases stale, recorded as fact in the artifact whose entire
 * purpose is reproducing an installation exactly.
 *
 * A version constant that can disagree with the package is not a version, it is
 * a second opinion. Importing package.json makes drift unrepresentable, and the
 * publish gate asserts the built binary agrees with it.
 */

import pkg from '../package.json'

export const VERSION: string = pkg.version

/**
 * Is a newer CLI published? Returns the version string, or null when we are
 * current OR cannot tell. Never throws and never blocks: an update check that
 * can fail a command is worse than not checking.
 */
export async function checkForUpdate(): Promise<string | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/@datacore-one/cli/latest', {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { version: string }
    return data.version !== VERSION ? data.version : null
  } catch {
    return null
  }
}
