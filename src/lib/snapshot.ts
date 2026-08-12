/**
 * Snapshot management for reproducible Datacore installations.
 *
 * Creates and restores lock files (datacore.lock.yaml) similar to
 * pip's requirements.txt or npm's package-lock.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { join, basename } from 'path'
import { parse, stringify } from 'yaml'
import { listSpaces } from './space'
import { listModules } from './module'
import { checkDependencies, checkDatacore } from './dependency'
import { loadConfig } from '../config'
import { dataDir } from './paths'
import { VERSION } from '../version'

// Resolved per call, NOT frozen at import: the test suite points DATACORE_ROOT
// at a fixture, and a module-load constant would capture the developer's real
// ~/Data before any test could redirect it.
const DATA_DIR = () => dataDir()
const LOCK_FILE = () => join(dataDir(), 'datacore.lock.yaml')


export interface ModuleLock {
  name: string
  source: string       // git remote URL or "local"
  version?: string     // from module.yaml
  commit?: string      // git commit hash for exact reproducibility
  branch?: string      // git branch
}

export interface SpaceLock {
  name: string
  number: number
  type: 'personal' | 'team'
  source?: string      // git remote URL if tracked
  commit?: string      // git commit hash
}

export interface DependencyLock {
  name: string
  version: string
  required: boolean
}

export interface Snapshot {
  // Metadata
  version: string             // Lock file format version
  created: string             // ISO timestamp
  cliVersion: string          // datacore CLI version
  platform: string            // Platform info

  // Installation
  modules: ModuleLock[]
  spaces: SpaceLock[]
  dependencies: DependencyLock[]

  // Configuration (base only, no local overrides for privacy)
  settings?: Record<string, unknown>
}

/**
 * Get git info for a directory.
 */
function getGitInfo(path: string): { remote?: string; commit?: string; branch?: string } {
  if (!existsSync(join(path, '.git'))) {
    return {}
  }

  try {
    const remote = execSync('git remote get-url origin 2>/dev/null || true', {
      cwd: path,
      encoding: 'utf-8',
    }).trim() || undefined

    const commit = execSync('git rev-parse HEAD 2>/dev/null || true', {
      cwd: path,
      encoding: 'utf-8',
    }).trim() || undefined

    const branch = execSync('git branch --show-current 2>/dev/null || true', {
      cwd: path,
      encoding: 'utf-8',
    }).trim() || undefined

    return { remote, commit, branch }
  } catch {
    return {}
  }
}

/**
 * Create a snapshot of the current Datacore installation.
 */
export function createSnapshot(options: { includeSettings?: boolean } = {}): Snapshot {
  const { includeSettings = false } = options

  // Gather module info with git details
  const modules: ModuleLock[] = []
  for (const mod of listModules()) {
    const gitInfo = getGitInfo(mod.path)
    modules.push({
      name: mod.name,
      source: gitInfo.remote || 'local',
      version: mod.version,
      commit: gitInfo.commit,
      branch: gitInfo.branch,
    })
  }

  // Gather space info
  const spaces: SpaceLock[] = []
  for (const space of listSpaces()) {
    const gitInfo = getGitInfo(space.path)
    spaces.push({
      name: space.name,
      number: space.number,
      type: space.type,
      source: gitInfo.remote,
      commit: gitInfo.commit,
    })
  }

  // Gather dependency versions
  const deps = checkDependencies()
  const dependencies: DependencyLock[] = deps
    .filter((d) => d.installed && d.version)
    .map((d) => ({
      name: d.name,
      version: d.version!,
      required: d.required,
    }))

  // Build snapshot
  const snapshot: Snapshot = {
    version: '1.0',
    created: new Date().toISOString(),
    cliVersion: VERSION,
    platform: `${process.platform}-${process.arch}`,
    modules,
    spaces,
    dependencies,
  }

  // Optionally include settings (base only, not local)
  if (includeSettings) {
    const settingsPath = join(DATA_DIR(), '.datacore', 'settings.yaml')
    if (existsSync(settingsPath)) {
      try {
        const content = readFileSync(settingsPath, 'utf-8')
        snapshot.settings = parse(content) as Record<string, unknown>
      } catch {
        // Ignore parse errors
      }
    }
  }

  return snapshot
}

/**
 * Save a snapshot to the lock file.
 */
export function saveSnapshot(snapshot: Snapshot, path?: string): string {
  const lockPath = path || LOCK_FILE()
  const content = stringify(snapshot, {
    lineWidth: 0,  // Don't wrap lines
  })
  writeFileSync(lockPath, content)
  return lockPath
}

/**
 * Load a snapshot from a lock file.
 */
export function loadSnapshot(path?: string): Snapshot | null {
  const lockPath = path || LOCK_FILE()
  if (!existsSync(lockPath)) {
    return null
  }

  try {
    const content = readFileSync(lockPath, 'utf-8')
    return parse(content) as Snapshot
  } catch {
    return null
  }
}

/**
 * Compare current installation with a snapshot.
 */
export interface SnapshotDiff {
  modules: {
    added: string[]
    removed: string[]
    changed: Array<{ name: string; from: string; to: string }>
  }
  spaces: {
    added: string[]
    removed: string[]
  }
  dependencies: {
    changed: Array<{ name: string; expected: string; actual: string }>
  }
}

export function diffSnapshot(snapshot: Snapshot): SnapshotDiff {
  const current = createSnapshot()

  const diff: SnapshotDiff = {
    modules: { added: [], removed: [], changed: [] },
    spaces: { added: [], removed: [] },
    dependencies: { changed: [] },
  }

  // Compare modules
  const currentModules = new Map(current.modules.map((m) => [m.name, m]))
  const snapshotModules = new Map(snapshot.modules.map((m) => [m.name, m]))

  for (const [name, mod] of currentModules) {
    if (!snapshotModules.has(name)) {
      diff.modules.added.push(name)
    } else {
      const expected = snapshotModules.get(name)!
      if (expected.commit && mod.commit && expected.commit !== mod.commit) {
        diff.modules.changed.push({
          name,
          from: expected.commit.slice(0, 7),
          to: mod.commit.slice(0, 7),
        })
      }
    }
  }

  for (const name of snapshotModules.keys()) {
    if (!currentModules.has(name)) {
      diff.modules.removed.push(name)
    }
  }

  // Compare spaces
  const currentSpaces = new Set(current.spaces.map((s) => s.name))
  const snapshotSpaces = new Set(snapshot.spaces.map((s) => s.name))

  for (const name of currentSpaces) {
    if (!snapshotSpaces.has(name)) {
      diff.spaces.added.push(name)
    }
  }

  for (const name of snapshotSpaces) {
    if (!currentSpaces.has(name)) {
      diff.spaces.removed.push(name)
    }
  }

  // Compare dependencies
  const currentDeps = new Map(current.dependencies.map((d) => [d.name, d.version]))
  for (const dep of snapshot.dependencies) {
    const actualVersion = currentDeps.get(dep.name)
    if (actualVersion && actualVersion !== dep.version) {
      diff.dependencies.changed.push({
        name: dep.name,
        expected: dep.version,
        actual: actualVersion,
      })
    }
  }

  return diff
}

/**
 * Restore from a snapshot (install missing modules).
 */
export interface RestoreResult {
  modulesInstalled: string[]
  modulesFailed: Array<{ name: string; error: string }>
  spacesCreated: string[]
  warnings: string[]
}

export function restoreFromSnapshot(
  snapshot: Snapshot,
  options: { modules?: boolean; spaces?: boolean; dryRun?: boolean } = {}
): RestoreResult {
  const { modules = true, spaces = true, dryRun = false } = options
  const result: RestoreResult = {
    modulesInstalled: [],
    modulesFailed: [],
    spacesCreated: [],
    warnings: [],
  }

  // Install missing modules
  if (modules) {
    const currentModules = new Set(listModules().map((m) => m.name))

    for (const mod of snapshot.modules) {
      if (currentModules.has(mod.name)) {
        continue
      }

      if (mod.source === 'local') {
        result.warnings.push(`Module ${mod.name} was local, cannot restore`)
        continue
      }

      if (dryRun) {
        result.modulesInstalled.push(mod.name)
        continue
      }

      try {
        const modulesDir = join(DATA_DIR(), '.datacore', 'modules')
        if (!existsSync(modulesDir)) {
          mkdirSync(modulesDir, { recursive: true })
        }

        const modulePath = join(modulesDir, mod.name)

        // Clone at specific commit if available
        execSync(`git clone ${mod.source} "${modulePath}"`, { stdio: 'pipe' })

        if (mod.commit) {
          execSync(`git checkout ${mod.commit}`, { cwd: modulePath, stdio: 'pipe' })
        } else if (mod.branch) {
          execSync(`git checkout ${mod.branch}`, { cwd: modulePath, stdio: 'pipe' })
        }

        result.modulesInstalled.push(mod.name)
      } catch (err) {
        result.modulesFailed.push({
          name: mod.name,
          error: (err as Error).message,
        })
      }
    }
  }

  // Create missing spaces (structure only, not content)
  if (spaces) {
    const currentSpaces = new Set(listSpaces().map((s) => s.name))

    for (const space of snapshot.spaces) {
      if (currentSpaces.has(space.name)) {
        continue
      }

      if (dryRun) {
        result.spacesCreated.push(space.name)
        continue
      }

      // Only create the space if it has a git source (can be cloned)
      if (space.source) {
        try {
          const spacePath = join(DATA_DIR(), space.name)
          execSync(`git clone ${space.source} "${spacePath}"`, { stdio: 'pipe' })

          if (space.commit) {
            execSync(`git checkout ${space.commit}`, { cwd: spacePath, stdio: 'pipe' })
          }

          result.spacesCreated.push(space.name)
        } catch (err) {
          result.warnings.push(`Could not clone space ${space.name}: ${(err as Error).message}`)
        }
      } else {
        result.warnings.push(`Space ${space.name} has no git source, skipping`)
      }
    }
  }

  return result
}

/**
 * Check if a lock file exists.
 */
export function lockFileExists(path?: string): boolean {
  return existsSync(path || LOCK_FILE())
}
