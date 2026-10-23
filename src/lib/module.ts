import { runModulePostInstall } from './init'
/**
 * Module management utilities.
 *
 * Modules are optional extensions that add agents, commands, and skills.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join, basename, relative, isAbsolute } from 'path'
import { execFileSync } from './exec'
import { reattach } from './gitbranch'
import type { ModuleInfo } from '../types'
import { dataDir } from './paths'

const DATA_DIR = () => dataDir()
const MODULES_DIR = () => join(dataDir(), '.datacore', 'modules')

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
  /** Repo is not public: offer it, but never preselect, and say so. */
  private?: boolean
}

export const AVAILABLE_MODULES: AvailableModule[] = [
  // ── Core modules (auto-installed) ──────────────────────────────────
  {
    name: 'nightshift',
    description: 'Autonomous AI task execution (local mode)',
    repo: 'https://github.com/datacore-one/datacore-nightshift',
    features: ['Queues :AI: tasks for background processing', 'Morning briefing with results', 'Multi-persona evaluation'],
    // NOT core while the repo is private. `core: true` means "install this on
    // every machine", and the repo cannot be cloned without org access — so
    // every external install failed on it before reaching anything else.
    core: false,
    private: true,
  },
  // ── Optional modules (user selects) ────────────────────────────────
  {
    name: 'news',
    description: 'On-demand news aggregation with AI relevance scoring',
    repo: 'https://github.com/datacore-one/datacore-news',
    features: ['Multi-source aggregation', 'AI relevance scoring', 'Tiered processing'],
    core: false,
  },
  {
    name: 'slides',
    description: 'Presentation generation and slide indexing',
    repo: 'https://github.com/datacore-one/datacore-slides',
    features: ['Generate decks from content', 'Index slides for reuse', 'Template-driven output'],
    core: false,
  },
  {
    name: 'comms',
    description: 'Communications — brand, content, scheduling, engagement, landing pages',
    repo: 'https://github.com/datacore-one/datacore-comms',
    features: ['Brand positioning and voice', 'Content calendars', 'Engagement pipeline'],
    core: false,
  },
  {
    name: 'crm',
    description: 'Network intelligence — contacts, relationships, industry landscape',
    repo: 'https://github.com/datacore-one/datacore-crm',
    features: ['Track people, companies, projects', 'Relationship scoring', 'Dormant-contact surfacing'],
    core: false,
  },
  {
    name: 'meetings',
    description: 'Meeting lifecycle — standups, prep, transcription, routing',
    repo: 'https://github.com/datacore-one/datacore-meetings',
    features: ['Standup generation', 'Agenda prep from issues and calendar', 'Transcript processing'],
    core: false,
  },
  {
    name: 'mail',
    description: 'Email integration — AI classification and GTD task creation',
    repo: 'https://github.com/datacore-one/datacore-mail',
    features: ['Multi-account inbox processing', 'ACTIONABLE/INFORMATIONAL/IGNORE triage', 'Invoice extraction'],
    core: false,
  },
  {
    name: 'gigs',
    description: 'Concert radar — artists from your Spotify library playing near you',
    repo: 'https://github.com/datacore-one/datacore-gigs',
    features: ['Matches your liked artists against regional listings', 'Surfaces shows in the morning briefing', 'Nudges again when tickets are worth buying'],
    core: false,
  },
  {
    name: 'ventures',
    description: 'Autonomous venture framework — roles, cadences, budgets, hypotheses',
    repo: 'https://github.com/datacore-one/datacore-ventures',
    features: ['Cadence engine with overdue tracking', 'Budget ledger per venture', 'Hypothesis board'],
    core: false,
    private: true,
  },
  {
    name: 'telegram',
    description: 'Telegram bot — run Datacore sessions from your phone',
    repo: 'https://github.com/datacore-one/datacore-telegram',
    features: ['Per-chat persistent session', 'Full tool access', 'Mobile capture'],
    core: false,
    private: true,
  },
  // NOT LISTED, deliberately:
  //   research, gtd, github, goals, decisions, outbox, analytics, tab-capture,
  //   voice-terminal, whatsapp — these are CORE. They are tracked inside the
  //   main datacore repo and arrive with the clone, so listing them here would
  //   clone a second copy over the one already present. The test is the
  //   `repository:` field in module.yaml: a module that declares one is an
  //   independent clone, one that does not is core (see the datacore
  //   .gitignore, which states the same rule).
  //
  // Retired 2026-09-21:
  //   health   — superseded by the Practice
  //   trading  — superseded by Meridian
  //   campaigns — absorbed into comms v2.0.0
  // Removing them from the catalog rather than leaving them to fail on clone.
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
  if (!existsSync(MODULES_DIR())) {
    return []
  }

  const entries = readdirSync(MODULES_DIR(), { withFileTypes: true })
  const modules: ModuleInfo[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue

    const modulePath = join(MODULES_DIR(), entry.name)
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

  // No manifest, no module. Every directory under .datacore/modules/ used to
  // count, so `.datacore/modules/state/` -- a state directory holding one
  // subfolder and no manifest -- was reported as an installed module by
  // `datacore module list`, by the install summary, and to the assistant in the
  // first-run greeting ("13 modules installed", one of which does not exist).
  // The manifest is what defines a module everywhere else in this system.
  if (!configPath) return null

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
  if (!existsSync(MODULES_DIR())) {
    const { mkdirSync } = require('fs')
    mkdirSync(MODULES_DIR(), { recursive: true })
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

  const modulePath = join(MODULES_DIR(), name)

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

  // Install the module's own dependencies. `runModulePostInstall` used to have a
  // single caller inside `init`, so a module added AFTER setup arrived without
  // its requirements.txt and died on first import — reported from the first
  // external install, where `venture_init.py` failed on `import pydantic`
  // immediately after a clean `module install`.
  const post = runModulePostInstall(modulePath)
  if (post.ran && !post.success) {
    // A FAILURE, not a warning (MEM-68). The module is on disk but its code
    // cannot import what it needs, so the install did not succeed; exiting 0
    // here told every caller -- `module install --json`, `init` -- that it had.
    // The clone is kept so the retry below needs no network for the module.
    throw new ModuleDependencyError(info, post.type ?? 'unknown', `cd ${modulePath} && ${post.type === 'pip'
      ? '<Data>/.datacore/venv/bin/python -m pip install -r requirements.txt' : 'npm install'}`)
  }

  return info
}

/** The module was cloned but its dependencies failed to install: it is broken. */
export class ModuleDependencyError extends Error {
  constructor(public readonly module: ModuleInfo, public readonly depType: string, public readonly retry: string) {
    super(`${module.name} installed, but its ${depType} dependencies failed — the module is broken until they install. Retry with: ${retry}`)
    this.name = 'ModuleDependencyError'
  }
}

/**
 * How a module is kept up to date.
 *
 *   repo  -- its own git clone (`.git` inside it): `git pull` updates it.
 *   core  -- shipped inside the root Datacore repo (gtd, research, outbox, ...):
 *            no clone of its own, updated whenever the root repo is.
 *   local -- neither: a directory nobody tracks, so nothing can update it.
 *
 * Core modules used to be reported as "Not a git repository" and counted as
 * failed updates -- 10 false failures on every update of a healthy install.
 * The test is whether the root repo tracks files under the module's
 * directory, which is the same rule the root .gitignore states.
 */
export function moduleKind(modulePath: string, root: string = DATA_DIR()): 'repo' | 'core' | 'local' {
  if (existsSync(join(modulePath, '.git'))) return 'repo'
  const rel = relative(root, modulePath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return 'local'
  try {
    const out = execFileSync('git', ['ls-files', '--', rel], {
      cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000,
    }) as unknown as string
    return String(out).trim() ? 'core' : 'local'
  } catch {
    return 'local'
  }
}

export interface ModuleUpdateResult {
  name: string
  updated: boolean
  error?: string
  /** Shipped inside the root repo: updated with Datacore, not on its own. */
  core?: boolean
  /** Was on a detached HEAD and was moved back onto this branch first. */
  reattached?: string
}

/**
 * Update all modules or a specific module.
 */
export function updateModules(name?: string): ModuleUpdateResult[] {
  const modules = listModules()
  const results: ModuleUpdateResult[] = []

  const toUpdate = name ? modules.filter((m) => m.name === name) : modules

  for (const mod of toUpdate) {
    try {
      const kind = moduleKind(mod.path)
      if (kind === 'core') {
        results.push({ name: mod.name, updated: false, core: true })
        continue
      }
      if (kind === 'local') {
        results.push({ name: mod.name, updated: false, error: 'Not a git repository' })
        continue
      }
      // A module restored by an older CLI sits on a detached HEAD, where
      // `git pull` cannot work. Return it to its branch first -- or stop,
      // untouched, if that would strand commits.
      const back = reattach(mod.path)
      if (!back.ok) {
        results.push({ name: mod.name, updated: false, error: back.error })
        continue
      }
      execFileSync('git', ['pull'], { cwd: mod.path, stdio: 'pipe', timeout: 60000 })
      results.push({ name: mod.name, updated: true, ...(back.switched ? { reattached: back.branch } : {}) })
    } catch (err) {
      // git's own words, not "Command failed: git pull" (the summary shows one line).
      const stderr = String((err as { stderr?: Buffer | string }).stderr ?? '').trim()
      results.push({ name: mod.name, updated: false, error: stderr || (err as Error).message })
    }
  }

  return results
}

/** Counts for the update summary. Core modules are neither updated nor failed. */
export function tallyModuleResults(results: ModuleUpdateResult[]): { updated: number; current: number; core: number; failed: number } {
  const t = { updated: 0, current: 0, core: 0, failed: 0 }
  for (const r of results) {
    if (r.core) t.core++
    else if (r.updated) t.updated++
    else if (r.error) t.failed++
    else t.current++
  }
  return t
}

/**
 * Remove a module.
 */
export function removeModule(name: string): boolean {
  const modulePath = join(MODULES_DIR(), name)

  if (!existsSync(modulePath)) {
    return false
  }

  rmSync(modulePath, { recursive: true, force: true })
  return true
}
