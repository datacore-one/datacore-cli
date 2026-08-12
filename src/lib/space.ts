/**
 * Space management utilities.
 *
 * Spaces are numbered directories in ~/Data following the pattern [N]-[name]/
 */

import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'fs'
import { join, basename } from 'path'
import type { SpaceInfo } from '../types'
import { dataDir } from './paths'

const DATA_DIR = () => dataDir()

/**
 * List all spaces in the Datacore installation.
 */
export function listSpaces(): SpaceInfo[] {
  if (!existsSync(DATA_DIR())) {
    return []
  }

  const entries = readdirSync(DATA_DIR(), { withFileTypes: true })
  const spaces: SpaceInfo[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    // Match pattern: [N]-[name]
    const match = entry.name.match(/^(\d+)-(.+)$/)
    if (!match) continue

    const [, numStr, name] = match
    const number = parseInt(numStr!, 10)
    const path = join(DATA_DIR(), entry.name)

    spaces.push({
      name: entry.name,
      number,
      path,
      type: number === 0 ? 'personal' : 'team',
      hasGit: existsSync(join(path, '.git')),
      hasClaude: existsSync(join(path, 'CLAUDE.md')) || existsSync(join(path, 'CLAUDE.base.md')),
    })
  }

  // Sort by number
  spaces.sort((a, b) => a.number - b.number)

  return spaces
}

/**
 * Get info about a specific space by name or number.
 */
export function getSpace(nameOrNumber: string | number): SpaceInfo | null {
  const spaces = listSpaces()

  if (typeof nameOrNumber === 'number') {
    return spaces.find((s) => s.number === nameOrNumber) || null
  }

  // Try exact match first
  let space = spaces.find((s) => s.name === nameOrNumber)
  if (space) return space

  // Try partial match (e.g., "personal" matches "0-personal")
  space = spaces.find((s) => s.name.includes(nameOrNumber))
  return space || null
}

/**
 * Get the next available space number.
 */
export function getNextSpaceNumber(): number {
  const spaces = listSpaces()
  if (spaces.length === 0) return 0

  const maxNumber = Math.max(...spaces.map((s) => s.number))
  return maxNumber + 1
}

/**
 * Create a new space with the standard folder structure.
 */
export function createSpace(name: string, type: 'personal' | 'team' = 'team'): SpaceInfo {
  // Determine number
  const number = type === 'personal' ? 0 : getNextSpaceNumber()

  // Normalize name (lowercase, hyphenated)
  const normalizedName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const folderName = `${number}-${normalizedName}`
  const spacePath = join(DATA_DIR(), folderName)

  if (existsSync(spacePath)) {
    throw new Error(`Space already exists: ${folderName}`)
  }

  // Create main directory
  mkdirSync(spacePath, { recursive: true })

  // Personal spaces have GTD-focused structure per DIP-0009
  // Team spaces have the full organizational structure per DIP-0003
  const dirs = type === 'personal' ? [
    '.datacore',
    '.datacore/commands',
    '.datacore/agents',
    '.datacore/learning',
    '.datacore/state',
    '.datacore/env',
    'org',                    // GTD org files (inbox, next_actions, nightshift, habits)
    '0-inbox',                // File inbox (unprocessed files)
    'notes',                  // Personal knowledge base (Obsidian)
    'notes/journals',         // Daily personal journals
    'notes/pages',            // Wiki pages
    'notes/zettel',           // Atomic notes
    'journal',                // AI session journals (auto-generated)
    '3-knowledge',            // Structured knowledge
    '3-knowledge/pages',      // General wiki pages
    '3-knowledge/zettel',     // Atomic concept notes
    '3-knowledge/literature', // Source summaries
    '3-knowledge/reference',  // People, companies, glossary
    '4-archive',              // Historical/completed content
    'content',                // Generated content (blog, emails, etc.)
  ] : [
    '.datacore',
    '.datacore/commands',
    '.datacore/agents',
    '.datacore/learning',
    '.datacore/state',
    '.datacore/env',
    'org',
    '0-inbox',
    'journal',
    '1-tracks',
    '1-tracks/ops',
    '1-tracks/product',
    '1-tracks/dev',
    '1-tracks/research',
    '1-tracks/comms',
    '2-projects',
    '3-knowledge',
    '3-knowledge/pages',
    '3-knowledge/zettel',
    '3-knowledge/literature',
    '3-knowledge/reference',
    '4-archive',
  ]

  for (const dir of dirs) {
    mkdirSync(join(spacePath, dir), { recursive: true })
  }

  // Create GTD org files per DIP-0009
  if (type === 'personal') {
    // inbox.org - Single capture point (sacred, always process to zero)
    writeFileSync(
      join(spacePath, 'org', 'inbox.org'),
      `#+TITLE: Inbox
#+FILETAGS: :inbox:

Capture everything here. Process daily to zero.

* TODO Do more. With less.
* Inbox
`
    )

    // next_actions.org - Active tasks by focus area/context
    writeFileSync(
      join(spacePath, 'org', 'next_actions.org'),
      `#+TITLE: Next Actions
#+TODO: TODO NEXT WAITING | DONE CANCELED
#+FILETAGS: :tasks:

Tasks organized by focus area. Tag with :AI: to delegate to agents.

* TIER 1: STRATEGIC FOUNDATION
** /Projects
** /Work
* TIER 2: SUPPORTING WORK
** Admin
** Maintenance
* PERSONAL: LIFE & DEVELOPMENT
** /Personal Development
** /Health & Longevity
** Home & Family
** Financial Management
* RESEARCH & LEARNING
** Technology
** Skills
`
    )

    // nightshift.org - AI task queue (per DIP-0009 and DIP-0011)
    writeFileSync(
      join(spacePath, 'org', 'nightshift.org'),
      `#+TITLE: Nightshift Queue
#+TODO: QUEUED EXECUTING | DONE FAILED
#+FILETAGS: :nightshift:

AI tasks queued for overnight execution. Managed by /tomorrow command.

* Queue
`
    )

    // habits.org - Recurring behaviors
    writeFileSync(
      join(spacePath, 'org', 'habits.org'),
      `#+TITLE: Habits
#+FILETAGS: :habits:

Recurring behaviors and routines. Track with org-habit.

* Daily
* Weekly
* Monthly
`
    )

    // someday.org - Future possibilities
    writeFileSync(
      join(spacePath, 'org', 'someday.org'),
      `#+TITLE: Someday/Maybe
#+FILETAGS: :someday:

Ideas and projects for the future. Review monthly.

* Someday
* Maybe
`
    )

    // archive.org - Completed/canceled tasks
    writeFileSync(
      join(spacePath, 'org', 'archive.org'),
      `#+TITLE: Archive
#+FILETAGS: :archive:

Completed and canceled tasks. Searchable history.

* Archived Tasks
`
    )
  } else {
    writeFileSync(
      join(spacePath, 'org', 'inbox.org'),
      `#+TITLE: Inbox
#+FILETAGS: :inbox:

* Capture items here
`
    )

    writeFileSync(
      join(spacePath, 'org', 'next_actions.org'),
      `#+TITLE: Next Actions
#+FILETAGS: :tasks:

* Tasks
** TODO items go here
`
    )
  }

  // Create index file
  if (type === 'personal') {
    writeFileSync(
      join(spacePath, '_index.md'),
      `# Personal Space

Your personal knowledge base and GTD system.

## GTD Workflow

1. **Capture** → \`org/inbox.org\` - dump everything here
2. **Clarify** → Is it actionable? What's the next action?
3. **Organize** → Move to \`next_actions.org\` by focus area
4. **Reflect** → Weekly review, monthly strategic
5. **Engage** → Do the work, delegate with :AI: tags

## Org Files (GTD)

| File | Purpose |
|------|---------|
| [inbox.org](org/inbox.org) | Single capture point - process to zero daily |
| [next_actions.org](org/next_actions.org) | Active tasks by focus area |
| [nightshift.org](org/nightshift.org) | AI task queue (overnight processing) |
| [habits.org](org/habits.org) | Recurring behaviors |
| [someday.org](org/someday.org) | Future possibilities |
| [archive.org](org/archive.org) | Completed/canceled tasks |

## Knowledge

| Folder | Purpose |
|--------|---------|
| [notes/](notes/) | Personal knowledge base (Obsidian) |
| [notes/journals/](notes/journals/) | Daily personal journals |
| [3-knowledge/](3-knowledge/) | Structured knowledge (zettelkasten) |

## Other

- [journal/](journal/) - AI session journals (auto-generated)
- [content/](content/) - Generated content (drafts, emails)
- [0-inbox/](0-inbox/) - File inbox (process files here)
- [4-archive/](4-archive/) - Historical content
`
    )
  } else {
    writeFileSync(
      join(spacePath, '_index.md'),
      `# ${name}

Team space.

## Structure

- \`org/\` - Task coordination
- \`1-tracks/\` - Department work
- \`2-projects/\` - Code repositories
- \`3-knowledge/\` - Shared knowledge
- \`4-archive/\` - Historical content

## Quick Links

- [Inbox](org/inbox.org)
- [Tasks](org/next_actions.org)
- [Journal](journal/)
- [Knowledge](3-knowledge/)
`
    )
  }

  // Create CLAUDE context
  if (type === 'personal') {
    writeFileSync(
      join(spacePath, 'CLAUDE.base.md'),
      `# Personal Space

Personal GTD system and knowledge base (per DIP-0009).

## GTD Files

| File | Purpose | Process |
|------|---------|---------|
| \`org/inbox.org\` | Single capture point | Process to zero daily |
| \`org/next_actions.org\` | Active tasks by focus area | Work from here |
| \`org/nightshift.org\` | AI task queue | Auto-managed by /tomorrow |
| \`org/habits.org\` | Recurring behaviors | Track daily |
| \`org/someday.org\` | Future possibilities | Review monthly |
| \`org/archive.org\` | Completed tasks | Searchable history |

## Task States

| State | Meaning |
|-------|---------|
| \`TODO\` | Standard next action |
| \`NEXT\` | High priority, work today |
| \`WAITING\` | Blocked on external |
| \`DONE\` | Completed (terminal) |
| \`CANCELED\` | Will not do (terminal) |

## AI Delegation

Tag tasks with \`:AI:\` to delegate to agents:

| Tag | Agent | Autonomous |
|-----|-------|------------|
| \`:AI:content:\` | gtd-content-writer | Yes |
| \`:AI:research:\` | gtd-research-processor | Yes |
| \`:AI:data:\` | gtd-data-analyzer | Yes |
| \`:AI:pm:\` | gtd-project-manager | Yes |

## Knowledge Structure

| Location | Purpose |
|----------|---------|
| \`notes/\` | Personal knowledge base (Obsidian) |
| \`notes/journals/\` | Daily personal reflections |
| \`3-knowledge/zettel/\` | Atomic concept notes |
| \`3-knowledge/literature/\` | Source summaries |

## Daily Workflow

1. **Morning** - Run \`/today\` for briefing
2. **Capture** - Everything to inbox.org
3. **Process** - Clear inbox, route tasks
4. **Work** - Focus on NEXT items
5. **Evening** - Run \`/tomorrow\` for wrap-up

## See Also

Parent: ~/Data/CLAUDE.md
`
    )
  } else {
    writeFileSync(
      join(spacePath, 'CLAUDE.base.md'),
      `# ${name} Space

Team space for ${name}.

## Structure

See parent CLAUDE.md for full documentation.
`
    )
  }

  // Create .datacore/config.yaml
  writeFileSync(
    join(spacePath, '.datacore', 'config.yaml'),
    `# Space configuration
name: ${normalizedName}
type: ${type}
`
  )

  // Create learning files
  writeFileSync(join(spacePath, '.datacore', 'learning', 'patterns.md'), `# Patterns\n\nSuccessful approaches to remember.\n`)
  writeFileSync(join(spacePath, '.datacore', 'learning', 'corrections.md'), `# Corrections\n\nHuman feedback log.\n`)
  writeFileSync(join(spacePath, '.datacore', 'learning', 'preferences.md'), `# Preferences\n\nStyle and preference notes.\n`)

  // Create .gitignore
  writeFileSync(
    join(spacePath, '.gitignore'),
    type === 'personal'
      ? `.datacore/state/
.datacore/env/
CLAUDE.md
CLAUDE.local.md
`
      : `.datacore/state/
.datacore/env/
CLAUDE.md
CLAUDE.local.md
2-projects/
`
  )

  return {
    name: folderName,
    number,
    path: spacePath,
    type,
    hasGit: false,
    hasClaude: true,
  }
}

/**
 * Audit a space for missing structure.
 */
export interface SpaceAuditResult {
  space: string
  path: string
  issues: SpaceAuditIssue[]
  status: 'healthy' | 'warnings' | 'errors'
}

export interface SpaceAuditIssue {
  type: 'missing' | 'warning' | 'error'
  path: string
  message: string
}

export function auditSpace(nameOrPath: string): SpaceAuditResult {
  // Resolve space
  let spacePath: string
  let spaceName: string

  if (existsSync(nameOrPath) && statSync(nameOrPath).isDirectory()) {
    spacePath = nameOrPath
    spaceName = basename(nameOrPath)
  } else {
    const space = getSpace(nameOrPath)
    if (!space) {
      throw new Error(`Space not found: ${nameOrPath}`)
    }
    spacePath = space.path
    spaceName = space.name
  }

  const issues: SpaceAuditIssue[] = []

  // Required directories
  const requiredDirs = [
    '.datacore',
    'org',
    '0-inbox',
    'journal',
  ]

  for (const dir of requiredDirs) {
    if (!existsSync(join(spacePath, dir))) {
      issues.push({
        type: 'missing',
        path: dir,
        message: `Required directory missing: ${dir}`,
      })
    }
  }

  // Required files
  const requiredFiles = [
    'org/inbox.org',
    'org/next_actions.org',
  ]

  for (const file of requiredFiles) {
    if (!existsSync(join(spacePath, file))) {
      issues.push({
        type: 'missing',
        path: file,
        message: `Required file missing: ${file}`,
      })
    }
  }

  // Recommended structure
  const recommendedDirs = [
    '1-tracks',
    '2-projects',
    '3-knowledge',
    '4-archive',
    '.datacore/learning',
  ]

  for (const dir of recommendedDirs) {
    if (!existsSync(join(spacePath, dir))) {
      issues.push({
        type: 'warning',
        path: dir,
        message: `Recommended directory missing: ${dir}`,
      })
    }
  }

  // CLAUDE context files
  if (!existsSync(join(spacePath, 'CLAUDE.base.md')) && !existsSync(join(spacePath, 'CLAUDE.md'))) {
    issues.push({
      type: 'warning',
      path: 'CLAUDE.base.md',
      message: 'No CLAUDE context file found',
    })
  }

  // Determine status
  let status: SpaceAuditResult['status'] = 'healthy'
  if (issues.some((i) => i.type === 'error' || i.type === 'missing')) {
    status = 'errors'
  } else if (issues.some((i) => i.type === 'warning')) {
    status = 'warnings'
  }

  return {
    space: spaceName,
    path: spacePath,
    issues,
    status,
  }
}
