/**
 * Common types for the Datacore CLI.
 */

export interface Flags {
  [key: string]: string | boolean
}

export interface ParsedRest {
  args: string[]
  flags: Flags
}

export interface AgentInvocation {
  agent: string
  params: Record<string, unknown>
  stream?: boolean
}

export interface AgentResult {
  success: boolean
  output: string
  artifacts?: Record<string, string>
  error?: string
}

export interface OperationStep {
  name: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  error?: string
}

export interface OperationState {
  id: string
  operation: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  startedAt: string
  steps: OperationStep[]
  rollback?: string[]
  meta?: Record<string, unknown>
}

export interface DependencyCheck {
  name: string
  required: boolean
  installed: boolean
  version?: string
  installCommand?: string
}

/**
 * One ledger finding. `ok: false` is a real problem; `ok: null` means the check
 * could not run — a missing interpreter, an unreachable space. The two must
 * stay distinguishable, because a probe that renders "could not tell" as
 * "fine" is how a fleet reports itself healthy while a machine sits six weeks
 * behind, and rendering it as "broken" manufactures failures out of an
 * installation that simply predates the ledger.
 */
export interface LedgerCheck {
  name: string
  ok: boolean | null
  detail: string
}

export interface DoctorResult {
  platform: string
  arch: string
  home: string
  dataDir: string
  python?: { path: string | null; version?: string }
  datacoreExists: boolean
  dependencies: DependencyCheck[]
  status: 'ready' | 'missing_required' | 'missing_recommended' | 'ledger_degraded'
  mcpConfig?: { claudeDesktop: boolean; claudeCode: boolean }
  codePermissions?: { enableAll: boolean; mcpAllowed: boolean }
  ledger?: LedgerCheck[]
}

export interface SpaceInfo {
  name: string
  number: number
  path: string
  type: 'personal' | 'team'
  hasGit: boolean
  hasClaude: boolean
}

export interface ModuleInfo {
  name: string
  path: string
  version?: string
  description?: string
  agents: string[]
  commands: string[]
}

export interface ConfigValue {
  key: string
  value: unknown
  source: 'default' | 'base' | 'local'
}
