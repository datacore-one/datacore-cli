/**
 * Runs on a real Windows machine (CI: .github/workflows/windows.yml).
 *
 * tests/windows.test.ts proves the platform decisions; this proves they work
 * against real cmd.exe, real `where`, and real npm shims — the three things
 * that made every install fail on the first Windows machine.
 */
import { execFileSync, homeDir, runShell, which } from '../src/lib/exec'
import { resolveBinary } from '../src/lib/upgrade'
import { findPython } from '../src/lib/python'

let failed = 0
function check(name: string, ok: boolean, detail: unknown) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${String(detail)}`)
  if (!ok) failed++
}

const node = which('node')
check('which(node) finds node.exe', !!node && /node\.exe$/i.test(node), node)
const npm = which('npm')
check('which(npm) picks the .cmd shim, not the bash script', !!npm && /npm\.cmd$/i.test(npm), npm)
check('which(git) finds git', which('git') !== null, which('git'))
check('which(<missing>) is null', which('definitely-not-a-command-xyz') === null, which('definitely-not-a-command-xyz'))

let npmVersion = ''
try { npmVersion = String(execFileSync('npm', ['--version'], { encoding: 'utf-8', stdio: 'pipe' })).trim() } catch (e) { npmVersion = (e as Error).message }
check('execFileSync(npm) runs the .cmd shim', /^\d+\.\d+/.test(npmVersion), npmVersion)

let shellOut = ''
try { shellOut = String(runShell('echo first && echo second', { encoding: 'utf-8', stdio: 'pipe' })) } catch (e) { shellOut = (e as Error).message }
check('runShell handles && through cmd.exe', shellOut.includes('first') && shellOut.includes('second'), JSON.stringify(shellOut))

check('resolveBinary(npm) resolves', resolveBinary('npm') !== null, resolveBinary('npm'))
check('homeDir() is absolute', /^[A-Za-z]:\\/.test(homeDir()), homeDir())
check('findPython() finds an interpreter', findPython() !== null, findPython())

// The exact step that failed for the first Windows user: an install command
// run through the shell, then the installed binary found. CI only — it
// installs a global package.
if (process.env.CI) {
  let installErr = ''
  try { runShell('npm install -g @plur-ai/mcp', { stdio: 'inherit', timeout: 300000 }) } catch (e) { installErr = (e as Error).message }
  check('runShell(npm install -g ...) succeeds', installErr === '', installErr || 'installed')
  const plur = resolveBinary('plur-mcp')
  check('the installed binary is found afterwards', plur !== null, plur)
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall Windows checks passed')
