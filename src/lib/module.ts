/**
 * Module management utilities.
 *
 * Modules are optional extensions that add agents, commands, and skills.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join, basename } from 'path'
import { execFileSync } from 'child_process'
import type { ModuleInfo } from '../types'
import { DATACORE_DIR } from '../paths'

const MODULES_DIR = join(DATACORE_DIR, 'modules')

/**
 * Available modules catalog.
 * Core modules are installed automatically during init.
 * Optional modules are presented for user selection.
 */
export interface AvailableModule {
  name: string
  description: string
  repo: string
  features: string[]
  /** Core modules are auto-installed as part of the base Datacore experience */
  core: boolean
}

export const AVAILABLE_MODULES: AvailableModule[] = [
  // ── Core modules (auto-installed) ──────────────────────────────────
  {
    name: 'nightshift',
    description: 'Autonomous AI task execution (local mode)',
    repo: 'https://github.com/datacore-one/datacore-nightshift',
    features: ['Queues :AI: tasks for background processing', 'Morning briefing with results', 'Multi-persona evaluation'],
    core: true,
  },
  // ── Optional modules (user selects) ────────────────────────────────
  {
    name: 'health',
    description: 'Health and wellness tracking - sleep, exercise, habits',
    repo: 'https://github.com/datacore-one/datacore-health',
    features: ['Daily check-ins', 'Habit tracking and streaks', 'Health reports and correlations'],
    core: false,
  },
  {
    name: 'crm',
    description: 'Network intelligence and contact management',
    repo: 'https://github.com/datacore-one/datacore-crm',
    features: ['Contact profiles and interaction history', 'Relationship tracking', 'Industry landscape mapping'],
    core: false,
  },
  {
    name: 'meetings',
    description: 'Meeting lifecycle automation',
    repo: 'https://github.com/datacore-one/datacore-meetings',
    features: ['Pre-meeting briefs', 'Transcript processing', 'Action item extraction'],
    core: false,
  },
  {
    name: 'mail',
    description: 'Email integration and processing',
    repo: 'https://github.com/datacore-one/datacore-mail',
    features: ['Gmail adapter', 'AI classification and routing', 'Automated processing'],
    core: false,
  },
  {
    name: 'news',
    description: 'Automated news aggregation with AI-scored relevance',
    repo: 'https://github.com/datacore-one/datacore-news',
    features: ['Multi-source aggregation', 'AI relevance scoring', 'Tiered processing'],
    core: false,
  },
  {
    name: 'slides',
    description: 'Presentation generation via Gamma.app',
    repo: 'https://github.com/datacore-one/datacore-slides',
    features: ['Presentations via Gamma.app', 'AI-powered backgrounds', 'Template support'],
    core: false,
  },
  {
    name: 'trading',
    description: 'Position management and trading workflows',
    repo: 'https://github.com/datacore-one/datacore-trading',
    features: ['Position tracking', 'Performance analytics', 'Risk management'],
    core: false,
  },
  {
    name: 'telegram',
    description: 'Mobile access to Claude Code via Telegram',
    repo: 'https://github.com/datacore-one/datacore-telegram',
    features: ['Message relay', 'Command execution', 'File sharing'],
    core: false,
  },
  {
    name: 'campaigns',
    description: 'Landing pages, deployment, and A/B testing',
    repo: 'https://github.com/datacore-one/datacore-campaigns',
    features: ['Landing page generation', 'PostHog analytics', 'A/B testing'],
    core: false,
  },
]

/**
 * Get core modules (auto-installed).
 */
export function getCoreModules(): AvailableModule[] {
  return AVAILABLE_MODULES.filter(m => m.core)
}

/**
 * Get optional modules not yet installed.
 */
export function getOptionalModules(): AvailableModule[] {
  const installed = listModules().map(m => m.name)
  return AVAILABLE_MODULES.filter(m => !m.core && !installed.includes(m.name))
}

/**
 * Get list of available (not yet installed) modules.
 */
export function getAvailableModules(): AvailableModule[] {
  const installed = listModules().map(m => m.name)
  return AVAILABLE_MODULES.filter(m => !installed.includes(m.name))
}

/**
 * List installed modules.
 */
export function listModules(): ModuleInfo[] {
  if (!existsSync(MODULES_DIR)) {
    return []
  }

  const entries = readdirSync(MODULES_DIR, { withFileTypes: true })
  const modules: ModuleInfo[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue

    const modulePath = join(MODULES_DIR, entry.name)
    const info = getModuleInfo(modulePath)
    if (info) {
      modules.push(info)
    }
  }

  return modules
}

/**
 * Get info about a specific module.
 */
export function getModuleInfo(modulePath: string): ModuleInfo | null {
  const name = basename(modulePath)

  // Check for module.yaml
  const yamlPath = join(modulePath, 'module.yaml')
  const ymlPath = join(modulePath, 'module.yml')
  const configPath = existsSync(yamlPath) ? yamlPath : existsSync(ymlPath) ? ymlPath : null

  let version: string | undefined
  let description: string | undefined

  if (configPath) {
    try {
      const { parse } = require('yaml')
      const content = readFileSync(configPath, 'utf-8')
      const config = parse(content) as Record<string, unknown>
      version = config.version as string | undefined
      description = config.description as string | undefined
    } catch {
      // Ignore parse errors
    }
  }

  // Discover agents
  const agentsDir = join(modulePath, 'agents')
  const agents: string[] = []
  if (existsSync(agentsDir)) {
    const agentFiles = readdirSync(agentsDir)
    for (const file of agentFiles) {
      if (file.endsWith('.md')) {
        agents.push(file.replace('.md', ''))
      }
    }
  }

  // Discover commands
  const commandsDir = join(modulePath, 'commands')
  const commands: string[] = []
  if (existsSync(commandsDir)) {
    const cmdFiles = readdirSync(commandsDir)
    for (const file of cmdFiles) {
      if (file.endsWith('.md')) {
        commands.push(file.replace('.md', ''))
      }
    }
  }

  return {
    name,
    path: modulePath,
    version,
    description,
    agents,
    commands,
  }
}

/**
 * Install a module from a git URL or npm package.
 */
export function installModule(source: string): ModuleInfo {
  if (!existsSync(MODULES_DIR)) {
    const { mkdirSync } = require('fs')
    mkdirSync(MODULES_DIR, { recursive: true })
  }

  // Determine module name from source
  let name: string
  let isGit = false

  if (source.includes('github.com') || source.startsWith('git@') || source.endsWith('.git')) {
    // Git URL
    isGit = true
    const match = source.match(/([^/]+?)(?:\.git)?$/)
    name = match?.[1] ?? source.split('/').pop() ?? 'unknown'
    // Remove repo naming prefixes to get clean module name
    name = name.replace(/^module-/, '').replace(/^datacore-/, '')
  } else if (source.startsWith('@')) {
    // npm scoped package
    name = source.split('/').pop()?.replace(/^datacore-/, '') ?? 'unknown'
  } else {
    // Plain name, assume npm package or direct module name
    name = source.replace(/^datacore-/, '').replace(/^module-/, '')
  }

  const modulePath = join(MODULES_DIR, name)

  if (existsSync(modulePath)) {
    throw new Error(`Module already installed: ${name}`)
  }

  if (isGit) {
    // Clone from git - try HTTPS first, fall back to SSH
    try {
      execFileSync('git', ['clone', source, modulePath], { stdio: 'pipe', timeout: 300000 })
    } catch {
      // If HTTPS fails, try SSH for private repos
      const sshUrl = source.replace('https://github.com/', 'git@github.com:')
      try {
        execFileSync('git', ['clone', sshUrl, modulePath], { stdio: 'pipe', timeout: 300000 })
      } catch {
        throw new Error(`Could not clone module: ${source} (tried HTTPS and SSH)`)
      }
    }
  } else {
    // Plain name - look up in catalog first, then try common URL patterns
    const catalogEntry = AVAILABLE_MODULES.find(m => m.name === name)
    if (catalogEntry) {
      return installModule(catalogEntry.repo)
    }

    // Try datacore-one org with common naming patterns
    const urls = [
      `https://github.com/datacore-one/datacore-${name}`,
      `https://github.com/datacore-one/module-${name}`,
    ]

    let installed = false
    for (const url of urls) {
      try {
        execFileSync('git', ['clone', url, modulePath], { stdio: 'pipe', timeout: 300000 })
        installed = true
        break
      } catch {
        continue
      }
    }

    if (!installed) {
      throw new Error(`Could not install module "${source}". Try providing a full git URL.`)
    }
  }

  const info = getModuleInfo(modulePath)
  if (!info) {
    // Cleanup on failure
    rmSync(modulePath, { recursive: true, force: true })
    throw new Error('Invalid module: missing module.yaml')
  }

  return info
}

/**
 * Update all modules or a specific module.
 */
export function updateModules(name?: string): Array<{ name: string; updated: boolean; error?: string }> {
  const modules = listModules()
  const results: Array<{ name: string; updated: boolean; error?: string }> = []

  const toUpdate = name ? modules.filter((m) => m.name === name) : modules

  for (const mod of toUpdate) {
    try {
      // Check if it's a git repo
      const gitDir = join(mod.path, '.git')
      if (existsSync(gitDir)) {
        execFileSync('git', ['pull'], { cwd: mod.path, stdio: 'pipe', timeout: 60000 })
        results.push({ name: mod.name, updated: true })
      } else {
        results.push({ name: mod.name, updated: false, error: 'Not a git repository' })
      }
    } catch (err) {
      results.push({ name: mod.name, updated: false, error: (err as Error).message })
    }
  }

  return results
}

/**
 * Remove a module.
 */
export function removeModule(name: string): boolean {
  const modulePath = join(MODULES_DIR, name)

  if (!existsSync(modulePath)) {
    return false
  }

  rmSync(modulePath, { recursive: true, force: true })
  return true
}
