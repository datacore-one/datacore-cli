/**
 * Plain output when an agent is driving the terminal.
 *
 * Cursor's agent runs commands in a real pseudo-terminal, so isTTY is true and
 * the CLI animated for it: a spinner redrawing 12 times a second, streamed
 * winget and npm progress bars, a ticker every 30 s. The agent keeps what it
 * reads in its chat history, which Cursor stores in state.vscdb — the file that
 * grew too large to open on a user's machine (docs/incidents/2026-09-27-...).
 * An agent also cannot answer the wizard's prompts, so init must send it to the
 * --answers path instead.
 */
import { describe, it, expect } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { agentDriving, richOutput } from '../src/lib/output'

describe('agentDriving', () => {
  it('recognises Cursor, Claude Code, Codex and Gemini CLI', () => {
    expect(agentDriving({ CURSOR_AGENT: '1' })).toBe('Cursor')
    expect(agentDriving({ CLAUDECODE: '1' })).toBe('Claude Code')
    expect(agentDriving({ CODEX_SANDBOX: 'seatbelt' })).toBe('Codex')
    expect(agentDriving({ GEMINI_CLI: '1' })).toBe('Gemini CLI')
  })
  it('is null for a person at a terminal', () => {
    expect(agentDriving({ TERM_PROGRAM: 'vscode' })).toBeNull()
    expect(agentDriving({})).toBeNull()
  })
})

describe('richOutput', () => {
  it('is on only for a real terminal with nobody else driving it', () => {
    expect(richOutput(true, {})).toBe(true)
    expect(richOutput(false, {})).toBe(false)
    expect(richOutput(true, { CURSOR_AGENT: '1' })).toBe(false)
    expect(richOutput(true, { DATACORE_PLAIN: '1' })).toBe(false)
    expect(richOutput(true, { CI: 'true' })).toBe(false)
  })
})

// A real pseudo-terminal, as Cursor gives its agent: isTTY is true here.
const scriptArgs = (cmd: string[]) =>
  process.platform === 'darwin' ? ['-q', '/dev/null', ...cmd]
    : process.platform === 'linux' ? ['-qec', cmd.join(' '), '/dev/null']
      : null

describe('init under an agent, in a real pseudo-terminal', () => {
  const args = scriptArgs(['bun', 'run', join(import.meta.dir, '..', 'src', 'index.ts'), 'init'])
  it.skipIf(!args)('refuses the wizard, names the agent path, and does not animate', () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-cli-agent-'))
    try {
      const r = spawnSync('script', args!, {
        encoding: 'utf-8', timeout: 30000,
        env: { ...process.env, CURSOR_AGENT: '1', DATACORE_ROOT: join(root, 'Data'), DATACORE_NO_UPDATE_CHECK: '1' },
      })
      const out = `${r.stdout}${r.stderr}`
      expect(out).toContain('--answers')
      expect(out).toContain('Cursor')
      expect(out).not.toContain('\x1b[?25l')      // spinner hides the cursor
      expect(out).not.toContain('\x1b[2J')        // console.clear
      expect(out.length).toBeLessThan(3000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 40000)
})
