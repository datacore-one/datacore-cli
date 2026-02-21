/**
 * CLI argument parsing and routing.
 */

import type { Flags, ParsedRest } from './types'

export type ParsedCommand =
  | { type: 'resource'; resource: string; action: string; args: string[]; flags: Flags }
  | { type: 'meta'; command: string; args: string[]; flags: Flags }
  | { type: 'help'; topic?: string; subtopic?: string }
  | { type: 'unknown'; command: string }

// Resources with subcommands: datacore <resource> <action>
export const RESOURCES = ['space', 'module', 'config', 'nightshift', 'cron', 'snapshot'] as const
export type Resource = typeof RESOURCES[number]

// Meta commands (single word): datacore <command>
export const META_COMMANDS = [
  'init',
  'update',
  'upgrade',
  'doctor',
  'ingest',
  'sync',
  'today',
  'tomorrow',
  'version',
] as const
export type MetaCommand = typeof META_COMMANDS[number]

// Actions per resource
export const ACTIONS: Record<Resource, readonly string[]> = {
  space: ['create', 'list'],
  module: ['install', 'list', 'update', 'remove'],
  config: ['show', 'get', 'set'],
  nightshift: ['status', 'trigger', 'queue'],
  cron: ['install', 'status', 'remove'],
  snapshot: ['create', 'restore', 'diff', 'show'],
} as const

export function parseArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0) {
    return { type: 'help', topic: undefined, subtopic: undefined }
  }

  const [first, ...rest] = argv
  if (!first) {
    return { type: 'help', topic: undefined, subtopic: undefined }
  }

  // Check for --help or -h anywhere in args
  const helpIndex = argv.findIndex(a => a === '--help' || a === '-h')
  if (helpIndex !== -1) {
    if (helpIndex === 0) {
      return { type: 'help', topic: undefined, subtopic: undefined }
    }
    if (helpIndex === 1 && RESOURCES.includes(first as Resource)) {
      return { type: 'help', topic: first, subtopic: undefined }
    }
    if (helpIndex === 2 && RESOURCES.includes(first as Resource)) {
      return { type: 'help', topic: first, subtopic: rest[0] }
    }
    return { type: 'help', topic: first, subtopic: undefined }
  }

  // Version shortcuts
  if (first === '--version' || first === '-v') {
    return { type: 'meta', command: 'version', args: [], flags: {} }
  }

  // Help command
  if (first === 'help') {
    return { type: 'help', topic: rest[0], subtopic: rest[1] }
  }

  // Meta commands (single word, no subcommand)
  if (META_COMMANDS.includes(first as MetaCommand)) {
    const { args, flags } = parseRest(rest)
    return { type: 'meta', command: first, args, flags }
  }

  // Resource commands (resource + action)
  if (RESOURCES.includes(first as Resource)) {
    const action = rest[0] || 'list'
    const { args, flags } = parseRest(rest.slice(1))
    return { type: 'resource', resource: first, action, args, flags }
  }

  // Unknown command
  return { type: 'unknown', command: first }
}

function parseRest(argv: string[]): ParsedRest {
  const args: string[] = []
  const flags: Flags = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue

    if (arg.startsWith('--')) {
      // Handle --flag=value syntax
      if (arg.includes('=')) {
        const [key, value] = arg.slice(2).split('=')
        if (key) flags[key] = value ?? true
      } else {
        const key = arg.slice(2)
        const next = argv[i + 1]
        // Check if next arg is a value (not starting with -)
        if (next && !next.startsWith('-')) {
          flags[key] = next
          i++
        } else {
          // Boolean flag
          flags[key] = true
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      // Short flags like -y, -v
      const key = arg.slice(1)
      flags[key] = true
    } else {
      // Positional argument
      args.push(arg)
    }
  }

  return { args, flags }
}

export function suggestCommand(unknown: string): string | null {
  const allCommands = [...META_COMMANDS, ...RESOURCES]

  // Simple Levenshtein-like matching
  for (const cmd of allCommands) {
    if (cmd.startsWith(unknown) || unknown.startsWith(cmd)) {
      return cmd
    }
    // Check for single character difference
    if (Math.abs(cmd.length - unknown.length) <= 1) {
      let diff = 0
      for (let i = 0; i < Math.max(cmd.length, unknown.length); i++) {
        if (cmd[i] !== unknown[i]) diff++
      }
      if (diff <= 2) return cmd
    }
  }

  return null
}
