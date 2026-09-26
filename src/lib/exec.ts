/**
 * Process spawning and command lookup that work on native Windows.
 *
 * Every other module spawns through here. The first Windows install failed
 * on all seven tools because each install ran via `/bin/bash`, which Windows
 * does not have; lookups used `which`, also absent, so every tool looked
 * missing; and npm's `.cmd` shims cannot be spawned without a shell (Node
 * refuses them outright since CVE-2024-27980). On macOS and Linux everything
 * here is a passthrough, so behaviour there is unchanged.
 *
 * The decisions are pure functions of the platform so they can be tested on
 * the Mac this is developed on: tests/windows.test.ts.
 */

import * as cp from 'child_process'
import type { ExecFileSyncOptions, SpawnOptions, ChildProcess } from 'child_process'
import { homedir } from 'os'
import { join, extname } from 'path'

const IS_WINDOWS = process.platform === 'win32'

/**
 * The user's home directory. HOME is unset on native Windows, and
 * `join(process.env.HOME || '', 'Data')` is then the RELATIVE path `Data` —
 * the second brain would be created in whatever directory init ran from.
 */
export function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir()
}

/** How to run a command string that may contain pipes and `&&`. */
export function shellInvocation(command: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === 'win32') {
    // /d: skip AutoRun, /s: take the rest literally, /c: run and exit.
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
  }
  return { file: '/bin/bash', args: ['-c', command] }
}

export function whichInvocation(cmd: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  return platform === 'win32' ? { file: 'where', args: [cmd] } : { file: 'which', args: [cmd] }
}

/**
 * `where npm` prints the extensionless bash script before npm.cmd; only the
 * latter is runnable from cmd or Node. Prefer anything with an executable
 * extension, and fall back to the first line.
 */
export function pickWhereResult(output: string): string | null {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return null
  const runnable = ['.exe', '.cmd', '.bat', '.com']
  return lines.find((l) => runnable.includes(extname(l).toLowerCase())) ?? lines[0]!
}

/** Where `npm install -g` puts a binary under a given prefix. */
export function npmBinCandidates(prefix: string, cmd: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? [join(prefix, `${cmd}.cmd`)] : [join(prefix, 'bin', cmd)]
}

export function needsShell(file: string): boolean {
  return /\.(cmd|bat)$/i.test(file)
}

/** Quote one argument for a cmd.exe command line. */
export function quoteWindowsArg(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"&|<>^%(),;!]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

/** Absolute path of `cmd` on PATH, or null. */
export function which(cmd: string): string | null {
  const inv = whichInvocation(cmd)
  try {
    const out = cp.execFileSync(inv.file, inv.args, { stdio: 'pipe', encoding: 'utf-8' })
    return IS_WINDOWS ? pickWhereResult(out) : (out.trim() || null)
  } catch {
    return null
  }
}

/**
 * On Windows, turn a bare command name into something spawnable: `.exe` runs
 * directly with args untouched; a `.cmd`/`.bat` shim runs through cmd.exe
 * with its args quoted. Anything unresolvable is passed through unchanged, so
 * the caller sees the same ENOENT it would have.
 */
function windowsTarget(file: string, args: readonly string[]): { file: string; args: string[]; shell: boolean } {
  const resolved = /[\\/]/.test(file) ? file : which(file)
  if (resolved && needsShell(resolved)) {
    return { file: quoteWindowsArg(resolved), args: args.map(quoteWindowsArg), shell: true }
  }
  return { file: resolved ?? file, args: [...args], shell: false }
}

/** Drop-in for child_process.execFileSync that can run npm shims on Windows. */
export function execFileSync(file: string, args: readonly string[] = [], options?: ExecFileSyncOptions): any {
  if (!IS_WINDOWS) return cp.execFileSync(file, args, options)
  const t = windowsTarget(file, args)
  return cp.execFileSync(t.file, t.args, t.shell ? { ...options, shell: true } : options)
}

/** Drop-in for child_process.spawn with the same Windows handling. */
export function spawn(file: string, args: readonly string[] = [], options: SpawnOptions = {}): ChildProcess {
  if (!IS_WINDOWS) return cp.spawn(file, args, options)
  const t = windowsTarget(file, args)
  return cp.spawn(t.file, t.args, t.shell ? { ...options, shell: true } : options)
}

/** Run a command string (pipes, &&) through the platform's shell. */
export function runShell(command: string, options?: ExecFileSyncOptions): any {
  const inv = shellInvocation(command)
  return cp.execFileSync(inv.file, inv.args, IS_WINDOWS ? ({ ...options, windowsVerbatimArguments: true } as ExecFileSyncOptions) : options)
}

/**
 * winget updates the registry PATH, not this process's. Without re-reading
 * it, git installed a second ago is "not found", and npm — needed for the
 * next four installs — does not exist yet. No-op outside Windows.
 */
export function refreshWindowsPath(): void {
  if (!IS_WINDOWS) return
  try {
    const out = cp.execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
    ], { stdio: 'pipe', encoding: 'utf-8', timeout: 15000 }).trim()
    if (!out) return
    const current = (process.env.Path ?? process.env.PATH ?? '').split(';')
    const merged = [...new Set([...out.split(';'), ...current].filter(Boolean))].join(';')
    process.env.Path = merged
    process.env.PATH = merged
  } catch { /* keep the PATH we have */ }
}
