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

export interface DoctorResult {
  platform: string
  arch: string
  home: string
  datacoreExists: boolean
  dependencies: DependencyCheck[]
  status: 'ready' | 'missing_required' | 'missing_recommended'
  mcpConfig?: { claudeDesktop: boolean; claudeCode: boolean }
  codePermissions?: { enableAll: boolean; mcpAllowed: boolean }
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
