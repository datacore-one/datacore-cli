/**
 * Structured CLI errors with codes, exit codes, and recovery hints.
 */

export type ErrorCode =
  | 'ERR_MISSING_DEPENDENCY'
  | 'ERR_MISSING_CLAUDE'
  | 'ERR_INVALID_ARGUMENT'
  | 'ERR_INVALID_PATH'
  | 'ERR_NOT_FOUND'
  | 'ERR_ALREADY_EXISTS'
  | 'ERR_GIT_ERROR'
  | 'ERR_AGENT_ERROR'
  | 'ERR_CONFIG_ERROR'
  | 'ERR_NETWORK_ERROR'
  | 'ERR_PERMISSION_DENIED'
  | 'ERR_OPERATION_FAILED'
  | 'ERR_NOT_INITIALIZED'
  | 'ERR_INVALID_SPACE'
  | 'ERR_MODULE_ERROR'
  | 'ERR_DAEMON_NOT_RUNNING'
  | 'ERR_DAEMON_STATE_INVALID'

const EXIT_CODES: Record<ErrorCode, number> = {
  ERR_MISSING_DEPENDENCY: 2,
  ERR_MISSING_CLAUDE: 2,
  ERR_INVALID_ARGUMENT: 1,
  ERR_INVALID_PATH: 1,
  ERR_NOT_FOUND: 4,
  ERR_ALREADY_EXISTS: 1,
  ERR_GIT_ERROR: 3,
  ERR_AGENT_ERROR: 3,
  ERR_CONFIG_ERROR: 1,
  ERR_NETWORK_ERROR: 4,
  ERR_PERMISSION_DENIED: 5,
  ERR_OPERATION_FAILED: 3,
  ERR_NOT_INITIALIZED: 1,
  ERR_INVALID_SPACE: 1,
  ERR_MODULE_ERROR: 3,
  ERR_DAEMON_NOT_RUNNING: 4,
  ERR_DAEMON_STATE_INVALID: 4,
}

const RECOVERABLE: Set<ErrorCode> = new Set([
  'ERR_NETWORK_ERROR',
  'ERR_AGENT_ERROR',
  'ERR_GIT_ERROR',
])

export class CLIError extends Error {
  code: ErrorCode
  exitCode: number
  recoverable: boolean
  hint: string | null

  constructor(code: ErrorCode, message: string, hint: string | null = null) {
    super(message)
    this.name = 'CLIError'
    this.code = code
    this.exitCode = EXIT_CODES[code]
    this.recoverable = RECOVERABLE.has(code)
    this.hint = hint
  }

  toJSON() {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        recoverable: this.recoverable,
        hint: this.hint,
      },
    }
  }

  toHuman(): string {
    let msg = `Error: ${this.message}`
    if (this.hint) msg += `\n\nHint: ${this.hint}`
    return msg
  }
}
