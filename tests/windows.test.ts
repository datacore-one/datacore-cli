/**
 * Native Windows install.
 *
 * The first Windows user got "✗ Failed to install" for all seven tools with
 * nothing streamed, because every install ran through `/bin/bash` — which
 * does not exist there, so the spawn itself failed before winget or npm ran.
 * Behind it sat three more: `which` (also absent) made every tool look
 * missing, so it tried to install node from inside a running node; npm's
 * `.cmd` shims cannot be spawned without a shell; and with HOME unset,
 * `join(process.env.HOME || '', 'Data')` is the relative path `Data`, so the
 * second brain would have landed in whatever directory init was run from.
 *
 * None of this can be observed on the Mac the CLI is developed on, so every
 * platform decision is a pure function of the platform, tested here for both.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  homeDir, shellInvocation, whichInvocation, pickWhereResult,
  npmBinCandidates, needsShell, quoteWindowsArg,
} from '../src/lib/exec'
import { getInstallCommand } from '../src/lib/platform'
import { venvPython } from '../src/lib/python-env'

const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('home directory', () => {
  it('falls back to USERPROFILE when HOME is unset (native Windows)', () => {
    delete process.env.HOME
    process.env.USERPROFILE = 'C:\\Users\\ana'
    expect(homeDir()).toBe('C:\\Users\\ana')
  })
  it('is never empty, so ~/Data can never become the relative path "Data"', () => {
    delete process.env.HOME
    delete process.env.USERPROFILE
    expect(homeDir().length).toBeGreaterThan(0)
  })
})

describe('running an install command', () => {
  it('uses cmd.exe on Windows, never /bin/bash', () => {
    const inv = shellInvocation('winget install --id Git.Git -e', 'win32')
    expect(inv.file.toLowerCase()).toContain('cmd')
    expect(inv.file).not.toContain('bash')
    expect(inv.args.join(' ')).toContain('winget install --id Git.Git -e')
  })
  it('keeps bash on macOS and Linux (install commands use pipes and &&)', () => {
    expect(shellInvocation('a && b', 'darwin')).toEqual({ file: '/bin/bash', args: ['-c', 'a && b'] })
    expect(shellInvocation('a && b', 'linux')).toEqual({ file: '/bin/bash', args: ['-c', 'a && b'] })
  })
})

describe('finding a command', () => {
  it('uses `where` on Windows and `which` elsewhere', () => {
    expect(whichInvocation('git', 'win32')).toEqual({ file: 'where', args: ['git'] })
    expect(whichInvocation('git', 'darwin')).toEqual({ file: 'which', args: ['git'] })
  })
  it('prefers the runnable shim: `where npm` lists the extensionless bash script first', () => {
    const out = 'C:\\Program Files\\nodejs\\npm\r\nC:\\Program Files\\nodejs\\npm.cmd\r\n'
    expect(pickWhereResult(out)).toBe('C:\\Program Files\\nodejs\\npm.cmd')
  })
  it('returns an .exe as-is', () => {
    expect(pickWhereResult('C:\\Program Files\\Git\\cmd\\git.exe\r\n')).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
  })
  it('returns null for empty output', () => {
    expect(pickWhereResult('')).toBeNull()
  })
})

describe('npm global binaries', () => {
  it('live in the prefix itself as .cmd on Windows, not prefix/bin', () => {
    expect(npmBinCandidates('C:\\Users\\ana\\AppData\\Roaming\\npm', 'plur-mcp', 'win32'))
      .toEqual([join('C:\\Users\\ana\\AppData\\Roaming\\npm', 'plur-mcp.cmd')])
  })
  it('live in prefix/bin elsewhere', () => {
    expect(npmBinCandidates('/usr/local', 'plur-mcp', 'darwin')).toEqual([join('/usr/local', 'bin', 'plur-mcp')])
  })
  it('.cmd and .bat shims need a shell to spawn (Node refuses them since CVE-2024-27980)', () => {
    expect(needsShell('C:\\x\\npm.cmd')).toBe(true)
    expect(needsShell('C:\\x\\run.BAT')).toBe(true)
    expect(needsShell('C:\\x\\git.exe')).toBe(false)
  })
  it('quotes arguments cmd.exe would split or interpret', () => {
    expect(quoteWindowsArg('install')).toBe('install')
    expect(quoteWindowsArg('C:\\Program Files\\x')).toBe('"C:\\Program Files\\x"')
    expect(quoteWindowsArg('a&b')).toBe('"a&b"')
    expect(quoteWindowsArg('say "hi"')).toBe('"say ""hi"""')
    expect(quoteWindowsArg('')).toBe('""')
  })
})

describe('winget', () => {
  it('installs by exact id and pre-accepts agreements, so an agent-driven run cannot stall on a prompt', () => {
    for (const pkg of ['git', 'node', 'python', 'gh']) {
      const cmd = getInstallCommand(pkg, 'windows')!
      expect(cmd).toContain('winget install')
      expect(cmd).toContain('--exact')
      expect(cmd).toContain('--accept-package-agreements')
      expect(cmd).toContain('--accept-source-agreements')
    }
  })
})

describe('python venv', () => {
  it('uses Scripts\\python.exe on Windows', () => {
    expect(venvPython('C:\\Users\\ana\\Data', 'win32'))
      .toBe(join('C:\\Users\\ana\\Data', '.datacore', 'venv', 'Scripts', 'python.exe'))
  })
  it('uses bin/python elsewhere', () => {
    expect(venvPython('/home/ana/Data', 'linux')).toBe(join('/home/ana/Data', '.datacore', 'venv', 'bin', 'python'))
  })
})

describe('no Windows-hostile calls outside exec.ts', () => {
  // The guard that stops this recurring: the bug was not one call site but a
  // habit, repeated in init, upgrade, dependency and agent. A new `which` or
  // `/bin/bash` anywhere else reintroduces it silently on the platform nobody
  // here runs.
  const srcDir = join(import.meta.dir, '..', 'src')
  const files: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else if (e.name.endsWith('.ts') && e.name !== 'exec.ts') files.push(join(d, e.name))
    }
  }
  walk(srcDir)

  const offenders = (re: RegExp) =>
    files.filter((f) => re.test(readFileSync(f, 'utf-8'))).map((f) => f.slice(srcDir.length + 1))

  it('does not spawn /bin/bash', () => {
    expect(offenders(/['"]\/bin\/bash['"]/)).toEqual([])
  })
  it('does not call `which`', () => {
    expect(offenders(/['"]which['"]\s*[,)]|`which \$\{/)).toEqual([])
  })
  it('does not build paths from process.env.HOME || ...', () => {
    expect(offenders(/process\.env\.HOME\s*\|\|/)).toEqual([])
  })
  it('does not import execFileSync or spawn straight from child_process', () => {
    expect(offenders(/import\s*\{[^}]*\b(execFileSync|spawn)\b[^}]*\}\s*from\s*'child_process'/)).toEqual([])
  })
})
