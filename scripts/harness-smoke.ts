/**
 * End-to-end: a machine with Codex and Antigravity installed gets both MCP
 * servers registered in each, with commands that exist. Uses a throwaway
 * home; run with HOME/USERPROFILE and DATACORE_ROOT pointing at temp dirs.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { homeDir } from '../src/lib/exec'
import { configureOtherHarnesses, mcpServerEntries } from '../src/lib/upgrade'

const home = homeDir()
mkdirSync(join(home, '.codex'), { recursive: true })
mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
const result = { updated: [] as string[], warnings: [] as string[], alreadyCurrent: [] as string[] }
configureOtherHarnesses(false, result)
console.log('updated:', result.updated, 'warnings:', result.warnings)

let failed = 0
const check = (name: string, ok: boolean, detail: unknown) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`); if (!ok) failed++ }
const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf-8')
check('codex has datacore', toml.includes('[mcp_servers.datacore]'), '')
check('codex has plur', toml.includes('[mcp_servers.plur]'), '')
const agy = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), 'utf-8'))
check('antigravity has both', !!agy.mcpServers?.datacore && !!agy.mcpServers?.plur, Object.keys(agy.mcpServers ?? {}))
const plur = mcpServerEntries().plur!
// Strict in CI, where the workflow installs @plur-ai/mcp first; locally the
// throwaway home has no PLUR in it, so only check what could be found.
if (process.env.CI || plur.command.includes('/') || plur.command.includes('\\')) {
  check('plur entry launches something that exists', existsSync(plur.command) && (!plur.args || existsSync(plur.args[0]!)), JSON.stringify(plur))
}
if (process.platform === 'win32') check('Windows entry runs node, not a .cmd shim', /node\.exe$/i.test(plur.command), plur.command)
const again = { updated: [] as string[], warnings: [] as string[], alreadyCurrent: [] as string[] }
configureOtherHarnesses(false, again)
check('second run changes nothing', again.updated.length === 0, again.alreadyCurrent)
if (failed) process.exit(1)
console.log('harness smoke passed')
