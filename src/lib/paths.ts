/**
 * Where the Datacore installation lives.
 *
 * Every module used to inline `join(process.env.HOME, 'Data')`, which hardcodes
 * two assumptions: that the install is at ~/Data, and that there is exactly one
 * per machine. Both are false in the fleet — hermes and plur-claw keep the core
 * in a runner directory separate from the agent's own space — and the CLI had
 * no way to be pointed at either.
 *
 * It also made the test suite read the developer's LIVE installation: the
 * snapshot tests scan ~/Data's real 40 modules and 9 spaces, which is why three
 * of them time out at 5s. A publish gate whose result depends on the
 * publisher's home directory is not a gate, so this indirection is what lets
 * the tests run against a fixture.
 *
 * DATACORE_ROOT is the same variable the Python side already honours
 * (ledger_daily.sh, fleet_status.py, ledger_checkpoint.py), so one installation
 * needs one answer, not one per language.
 */

import { join } from 'path'
import { homedir } from 'os'

export function dataDir(): string {
  return process.env.DATACORE_ROOT || join(process.env.HOME || homedir(), 'Data')
}

/** The core library directory — where the Python transport and tools live. */
export function datacoreLib(): string {
  return join(dataDir(), '.datacore', 'lib')
}
