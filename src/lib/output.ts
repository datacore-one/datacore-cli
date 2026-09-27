/**
 * Who is reading the output: a person at a terminal, or an agent.
 *
 * isTTY cannot tell them apart. Cursor's agent runs commands in a real
 * pseudo-terminal, so the CLI animated for it — a spinner redrawing 12 times a
 * second, streamed winget and npm progress, a 30-second ticker — and the agent
 * kept all of it in its chat history, which Cursor stores in state.vscdb. On a
 * user's machine that file grew too large for Cursor to open
 * (docs/incidents/2026-09-27-windows-cursor-crash.md).
 *
 * Harnesses mark their agent terminals with an environment variable; that is
 * the signal used here. A person typing into the same editor's terminal does
 * not have it set, so they keep the full wizard.
 */

const AGENT_MARKERS: Array<[string, string]> = [
  ['CURSOR_AGENT', 'Cursor'],       // https://cursor.com/docs/agent/tools/terminal
  ['CLAUDECODE', 'Claude Code'],
  ['CODEX_SANDBOX', 'Codex'],
  ['GEMINI_CLI', 'Gemini CLI'],
]

/** The harness whose agent is driving this terminal, or null. */
export function agentDriving(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const [key, name] of AGENT_MARKERS) {
    if (env[key]) return name
  }
  return null
}

/**
 * Animations, streamed installer output and interactive prompts: only for a
 * real terminal that no agent is driving. DATACORE_PLAIN=1 forces plain output.
 */
export function richOutput(isTTY: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return isTTY && !agentDriving(env) && !env.DATACORE_PLAIN && !env.CI
}
