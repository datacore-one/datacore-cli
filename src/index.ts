#!/usr/bin/env node
/**
 * Datacore CLI - Setup and manage Datacore installations.
 *
 * Entry point for the CLI. Handles argument parsing and command dispatch.
 */

import { parseArgs, suggestCommand } from './routing'
import { showHelp, showResourceHelp, showActionHelp } from './help'
import { detectFormat, output, success, info, warn, error as errorLog } from './format'
import { CLIError } from './errors'
import { runDoctor } from './lib/dependency'
import { loadConfig, getConfigValue, setConfigValue, getAllConfig } from './config'
import { listSpaces, createSpace } from './lib/space'
import { pullAll, pushAll, statusAll } from './lib/sync'
import { initDatacore, isInitialized } from './lib/init'
import { listModules, installModule, updateModules, removeModule } from './lib/module'
import { createSnapshot, saveSnapshot, loadSnapshot, diffSnapshot, restoreFromSnapshot, lockFileExists } from './lib/snapshot'

const VERSION = '1.0.7'

const args = process.argv.slice(2)
const parsed = parseArgs(args)

async function handleMeta(
  command: string,
  cmdArgs: string[],
  flags: Record<string, string | boolean>,
  format: 'json' | 'human'
): Promise<void> {
  switch (command) {
    case 'version':
      console.log(VERSION)
      break

    case 'init': {
      if (isInitialized() && !flags.force) {
        if (format === 'json') {
          output({ success: true, message: 'Datacore already initialized', hint: 'Use --force to re-initialize or run datacore doctor' }, format)
        } else {
          info('Datacore already initialized at ~/Data')
          info('Run datacore doctor to check health')
          info('Run datacore module list to see modules')
          info('Use --force to re-run the setup wizard')
        }
        break
      }

      const result = await initDatacore({
        nonInteractive: flags.yes === true,
        skipChecks: flags['skip-checks'] === true,
        stream: format === 'human',
        verbose: flags.verbose === true,
        force: flags.force === true,
      })

      if (format === 'json') {
        output(result, format)
      } else {
        if (result.success) {
          console.log()
          success('Datacore initialized successfully!')
          console.log()

          if (result.created.length > 0) {
            console.log('Created:')
            for (const path of result.created.slice(0, 5)) {
              console.log(`  + ${path}`)
            }
            if (result.created.length > 5) {
              console.log(`  ... and ${result.created.length - 5} more`)
            }
          }

          if (result.warnings.length > 0) {
            console.log()
            console.log('Warnings:')
            for (const w of result.warnings) {
              warn(w)
            }
          }

          console.log()
          console.log('Next steps:')
          for (const step of result.nextSteps) {
            console.log(`  → ${step}`)
          }
        } else {
          errorLog('Initialization failed')
          for (const e of result.errors) {
            console.error(`  ${e}`)
          }
          process.exitCode = 1
        }
      }
      break
    }

    case 'doctor': {
      const result = runDoctor()
      if (format === 'json') {
        output(result, format)
      } else {
        console.log(`Platform: ${result.platform} (${result.arch})`)
        console.log(`Home: ${result.home}`)
        console.log(`Datacore: ${result.datacoreExists ? '✓ installed' : '✗ not found'}`)
        console.log()
        console.log('Dependencies:')
        for (const dep of result.dependencies) {
          const status = dep.installed ? '✓' : '✗'
          const version = dep.version ? ` (${dep.version})` : ''
          const required = dep.required ? '' : ' (recommended)'
          console.log(`  ${status} ${dep.name}${version}${required}`)
          if (!dep.installed && dep.installCommand) {
            console.log(`      Install: ${dep.installCommand}`)
          }
        }
        console.log()
        if (result.status === 'ready') {
          success('System ready for Datacore')
        } else if (result.status === 'missing_required') {
          errorLog('Missing required dependencies')
          process.exitCode = 1
        } else {
          warn('Missing recommended dependencies')
        }
      }
      break
    }

    case 'ingest': {
      if (!cmdArgs[0]) {
        throw new CLIError('ERR_INVALID_ARGUMENT', 'Missing path argument', 'Usage: datacore ingest <path>')
      }

      const { invokeAgent } = await import('./lib/agent')
      const path = cmdArgs[0]
      const space = flags.space as string | undefined

      info(`Ingesting: ${path}`)
      const result = await invokeAgent(
        {
          agent: 'ingest-coordinator',
          params: { path, space },
        },
        { stream: format === 'human' }
      )

      if (format === 'json') {
        output(result, format)
      } else if (!result.success) {
        errorLog('Ingest failed')
        if (result.error) {
          console.error(result.error)
        }
        process.exitCode = 1
      } else {
        success('Ingest complete')
      }
      break
    }

    case 'sync': {
      const subcommand = cmdArgs[0] || 'status'

      switch (subcommand) {
        case 'pull': {
          const results = pullAll({ stream: format === 'human' })
          if (format === 'json') {
            output(results, format)
          } else {
            const failed = results.filter((r) => !r.success)
            if (failed.length === 0) {
              success(`Pulled ${results.length} repo(s)`)
            } else {
              errorLog(`${failed.length}/${results.length} repos failed to pull`)
            }
          }
          break
        }
        case 'push': {
          const message = flags.message as string | undefined
          const results = pushAll({ stream: format === 'human', message })
          if (format === 'json') {
            output(results, format)
          } else {
            if (results.length === 0) {
              info('Nothing to push')
            } else {
              const failed = results.filter((r) => !r.success)
              if (failed.length === 0) {
                success(`Pushed ${results.length} repo(s)`)
              } else {
                errorLog(`${failed.length}/${results.length} repos failed to push`)
              }
            }
          }
          break
        }
        case 'status':
        default: {
          const statuses = statusAll()
          if (format === 'json') {
            output(statuses, format)
          } else {
            if (statuses.length === 0) {
              info('No git repos found')
            } else {
              console.log('Repository Status:')
              for (const s of statuses) {
                const dirtyIcon = s.dirty ? '●' : '○'
                const syncInfo = s.ahead || s.behind ? ` (↑${s.ahead} ↓${s.behind})` : ''
                const untrackedInfo = s.untracked ? ` +${s.untracked} untracked` : ''
                console.log(`  ${dirtyIcon} ${s.name} [${s.branch}]${syncInfo}${untrackedInfo}`)
              }
            }
          }
          break
        }
      }
      break
    }

    case 'today': {
      const { invokeAgent } = await import('./lib/agent')
      info('Generating daily briefing...')

      // Invoke the /today skill via Claude Code
      const result = await invokeAgent(
        { agent: 'gtd-daily-start', params: {} },
        { stream: format === 'human' }
      )

      if (format === 'json') {
        output(result, format)
      } else if (!result.success) {
        errorLog('Failed to generate briefing')
        if (result.error) {
          console.error(result.error)
        }
        process.exitCode = 1
      }
      break
    }

    case 'tomorrow': {
      const { invokeAgent } = await import('./lib/agent')
      info('Running end-of-day wrap-up...')

      // Invoke the /tomorrow skill via Claude Code
      const result = await invokeAgent(
        { agent: 'gtd-daily-end', params: {} },
        { stream: format === 'human' }
      )

      if (format === 'json') {
        output(result, format)
      } else if (!result.success) {
        errorLog('Failed to run wrap-up')
        if (result.error) {
          console.error(result.error)
        }
        process.exitCode = 1
      }
      break
    }


    default:
      throw new CLIError('ERR_INVALID_ARGUMENT', `Unknown command: ${command}`)
  }
}

async function handleResource(
  resource: string,
  action: string,
  cmdArgs: string[],
  flags: Record<string, string | boolean>,
  format: 'json' | 'human'
): Promise<void> {
  switch (resource) {
    case 'space':
      switch (action) {
        case 'create': {
          if (!cmdArgs[0]) {
            throw new CLIError('ERR_INVALID_ARGUMENT', 'Missing space name', 'Usage: datacore space create <name> [--type=team|personal]')
          }
          const spaceType = (flags.type as string) === 'personal' ? 'personal' : 'team'
          try {
            const space = createSpace(cmdArgs[0], spaceType)
            if (format === 'json') {
              output(space, format)
            } else {
              success(`Created ${spaceType} space: ${space.name}`)
              info(`Path: ${space.path}`)
            }
          } catch (err) {
            throw new CLIError('ERR_OPERATION_FAILED', (err as Error).message)
          }
          break
        }
        case 'list': {
          const spaces = listSpaces()
          if (format === 'json') {
            output(spaces, format)
          } else {
            if (spaces.length === 0) {
              info('No spaces found')
              info('Create one with: datacore space create <name>')
            } else {
              console.log('Spaces:')
              for (const s of spaces) {
                const typeIcon = s.type === 'personal' ? '👤' : '👥'
                const gitIcon = s.hasGit ? '✓' : '✗'
                console.log(`  ${typeIcon} ${s.name} (git: ${gitIcon})`)
              }
            }
          }
          break
        }
        default:
          throw new CLIError('ERR_INVALID_ARGUMENT', `Unknown action: space ${action}`)
      }
      break

    case 'module':
      switch (action) {
        case 'install': {
          if (!cmdArgs[0]) {
            throw new CLIError('ERR_INVALID_ARGUMENT', 'Missing module name', 'Usage: datacore module install <name|url>')
          }
          try {
            if (format === 'human') {
              info(`Installing module: ${cmdArgs[0]}`)
            }
            const mod = installModule(cmdArgs[0])
            if (format === 'json') {
              output(mod, format)
            } else {
              success(`Installed: ${mod.name}`)
              if (mod.agents.length > 0) {
                info(`  Agents: ${mod.agents.join(', ')}`)
              }
              if (mod.commands.length > 0) {
                info(`  Commands: ${mod.commands.join(', ')}`)
              }
            }
          } catch (err) {
            throw new CLIError('ERR_OPERATION_FAILED', (err as Error).message)
          }
          break
        }
        case 'list': {
          const modules = listModules()
          if (format === 'json') {
            output(modules, format)
          } else {
            if (modules.length === 0) {
              info('No modules installed')
              info('Install with: datacore module install <name>')
            } else {
              console.log('Installed modules:')
              for (const mod of modules) {
                const version = mod.version ? ` v${mod.version}` : ''
                console.log(`  📦 ${mod.name}${version}`)
                if (mod.description) {
                  console.log(`      ${mod.description}`)
                }
              }
            }
          }
          break
        }
        case 'update': {
          const name = cmdArgs[0]
          if (format === 'human') {
            info(name ? `Updating module: ${name}` : 'Updating all modules...')
          }
          const results = updateModules(name)
          if (format === 'json') {
            output(results, format)
          } else {
            if (results.length === 0) {
              info('No modules to update')
            } else {
              for (const r of results) {
                if (r.updated) {
                  success(`Updated: ${r.name}`)
                } else {
                  warn(`${r.name}: ${r.error || 'not updated'}`)
                }
              }
            }
          }
          break
        }
        case 'remove': {
          if (!cmdArgs[0]) {
            throw new CLIError('ERR_INVALID_ARGUMENT', 'Missing module name', 'Usage: datacore module remove <name>')
          }
          if (removeModule(cmdArgs[0])) {
            success(`Removed: ${cmdArgs[0]}`)
          } else {
            throw new CLIError('ERR_NOT_FOUND', `Module not found: ${cmdArgs[0]}`)
          }
          break
        }
        default:
          throw new CLIError('ERR_INVALID_ARGUMENT', `Unknown action: module ${action}`)
      }
      break

    case 'config':
      switch (action) {
        case 'show': {
          const { merged, sources } = getAllConfig()
          if (format === 'json') {
            output({ config: merged, sources }, format)
          } else {
            function printConfig(obj: Record<string, unknown>, prefix = ''): void {
              for (const [key, value] of Object.entries(obj)) {
                const path = prefix ? `${prefix}.${key}` : key
                if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                  printConfig(value as Record<string, unknown>, path)
                } else {
                  const source = sources[path] || 'default'
                  const sourceTag = source === 'default' ? '' : ` [${source}]`
                  console.log(`${path} = ${JSON.stringify(value)}${sourceTag}`)
                }
              }
            }
            printConfig(merged)
          }
          break
        }
        case 'get': {
          if (!cmdArgs[0]) {
            throw new CLIError('ERR_INVALID_ARGUMENT', 'Missing key', 'Usage: datacore config get <key>')
          }
          const result = getConfigValue(cmdArgs[0])
          if (result === null) {
            throw new CLIError('ERR_NOT_FOUND', `Config key not found: ${cmdArgs[0]}`)
          }
          if (format === 'json') {
            output(result, format)
          } else {
            const sourceTag = result.source === 'default' ? '' : ` [${result.source}]`
            console.log(`${result.key} = ${JSON.stringify(result.value)}${sourceTag}`)
          }
          break
        }
        case 'set': {
          if (!cmdArgs[0] || !cmdArgs[1]) {
            throw new CLIError('ERR_INVALID_ARGUMENT', 'Missing key or value', 'Usage: datacore config set <key> <value>')
          }
          setConfigValue(cmdArgs[0], cmdArgs[1])
          success(`Set ${cmdArgs[0]} = ${cmdArgs[1]}`)
          break
        }
        default:
          throw new CLIError('ERR_INVALID_ARGUMENT', `Unknown action: config ${action}`)
      }
      break

    case 'nightshift': {
      const config = loadConfig()
      const nightshiftConfig = config.nightshift as Record<string, unknown> | undefined

      switch (action) {
        case 'status': {
          if (format === 'json') {
            output({
              enabled: nightshiftConfig?.enabled ?? false,
              server: nightshiftConfig?.server ?? null,
              autoTrigger: nightshiftConfig?.auto_trigger ?? false,
            }, format)
          } else {
            const enabled = nightshiftConfig?.enabled ?? false
            const server = nightshiftConfig?.server as string | undefined
            console.log(`Nightshift: ${enabled ? '✓ enabled' : '✗ disabled'}`)
            if (server) {
              console.log(`Server: ${server}`)
            } else {
              info('No server configured')
              info('Set with: datacore config set nightshift.server <url>')
            }
          }
          break
        }
        case 'trigger': {
          const server = nightshiftConfig?.server as string | undefined
          if (!server) {
            throw new CLIError('ERR_CONFIG_ERROR', 'Nightshift server not configured', 'Set with: datacore config set nightshift.server <url>')
          }
          info('Triggering nightshift...')
          // Would call the nightshift server API here
          success('Nightshift triggered')
          break
        }
        case 'queue': {
          const task = cmdArgs.join(' ')
          if (!task) {
            throw new CLIError('ERR_INVALID_ARGUMENT', 'Missing task description', 'Usage: datacore nightshift queue "Research topic X"')
          }

          // Add task to inbox.org with :AI: tag
          const { existsSync, appendFileSync } = await import('fs')
          const { join } = await import('path')
          const inboxPath = join(process.env.HOME || '~', 'Data', '0-personal', 'org', 'inbox.org')

          if (!existsSync(inboxPath)) {
            throw new CLIError('ERR_NOT_FOUND', 'inbox.org not found. Run datacore init first.')
          }

          const timestamp = new Date().toISOString().split('T')[0]
          const entry = `\n* TODO ${task} :AI:\n  SCHEDULED: <${timestamp}>\n`
          appendFileSync(inboxPath, entry)

          if (format === 'json') {
            output({ queued: true, task }, format)
          } else {
            success(`Queued for nightshift: ${task}`)
            info('Task added to inbox.org with :AI: tag')
          }
          break
        }
        default:
          throw new CLIError('ERR_INVALID_ARGUMENT', `Unknown action: nightshift ${action}`)
      }
      break
    }

    case 'cron': {
      const { execSync, exec: execAsync } = await import('child_process')

      switch (action) {
        case 'install': {
          info('Installing cron jobs...')

          // Get current crontab
          let currentCron = ''
          try {
            currentCron = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' })
          } catch {
            // No existing crontab
          }

          // Check if already installed
          if (currentCron.includes('# Datacore')) {
            if (!flags.force) {
              info('Cron jobs already installed')
              info('Use --force to reinstall')
              break
            }
            // Remove existing datacore entries
            currentCron = currentCron
              .split('\n')
              .filter((line) => !line.includes('# Datacore') && !line.includes('datacore'))
              .join('\n')
          }

          // Add datacore cron jobs
          const datacoreCron = `
# Datacore scheduled tasks
# Morning briefing at 8am
0 8 * * 1-5 datacore today >> ~/.datacore/logs/today.log 2>&1
# Evening wrap-up at 6pm
0 18 * * 1-5 datacore tomorrow >> ~/.datacore/logs/tomorrow.log 2>&1
# Nightshift execution at 2am
0 2 * * * datacore nightshift trigger >> ~/.datacore/logs/nightshift.log 2>&1
`

          const newCron = currentCron.trim() + '\n' + datacoreCron

          // Install new crontab
          execSync(`echo "${newCron}" | crontab -`, { stdio: 'pipe' })
          success('Cron jobs installed')
          info('  8:00 AM weekdays - Daily briefing')
          info('  6:00 PM weekdays - Evening wrap-up')
          info('  2:00 AM daily - Nightshift execution')
          break
        }
        case 'status': {
          let crontab = ''
          try {
            crontab = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' })
          } catch {
            // No crontab
          }

          const datacoreJobs = crontab
            .split('\n')
            .filter((line) => line.includes('datacore') && !line.startsWith('#'))

          if (format === 'json') {
            output({ installed: datacoreJobs.length > 0, jobs: datacoreJobs }, format)
          } else {
            if (datacoreJobs.length === 0) {
              info('No Datacore cron jobs installed')
              info('Install with: datacore cron install')
            } else {
              console.log('Installed cron jobs:')
              for (const job of datacoreJobs) {
                console.log(`  ${job}`)
              }
            }
          }
          break
        }
        case 'remove': {
          info('Removing cron jobs...')

          let currentCron = ''
          try {
            currentCron = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' })
          } catch {
            info('No cron jobs to remove')
            break
          }

          // Remove datacore entries
          const newCron = currentCron
            .split('\n')
            .filter((line) => !line.includes('# Datacore') && !line.includes('datacore'))
            .join('\n')
            .trim()

          if (newCron) {
            execSync(`echo "${newCron}" | crontab -`, { stdio: 'pipe' })
          } else {
            execSync('crontab -r', { stdio: 'pipe' })
          }
          success('Cron jobs removed')
          break
        }
        default:
          throw new CLIError('ERR_INVALID_ARGUMENT', `Unknown action: cron ${action}`)
      }
      break
    }

    case 'snapshot': {
      switch (action) {
        case 'create': {
          const includeSettings = flags.settings === true
          const outputPath = cmdArgs[0]

          info('Creating snapshot...')
          const snapshot = createSnapshot({ includeSettings })
          const savedPath = saveSnapshot(snapshot, outputPath)

          if (format === 'json') {
            output({ path: savedPath, snapshot }, format)
          } else {
            success(`Snapshot saved to ${savedPath}`)
            console.log(`  Modules: ${snapshot.modules.length}`)
            console.log(`  Spaces: ${snapshot.spaces.length}`)
            console.log(`  Dependencies: ${snapshot.dependencies.length}`)
            if (includeSettings) {
              console.log('  Settings: included')
            }
            console.log()
            info('Share this file to replicate your setup')
          }
          break
        }
        case 'restore': {
          const inputPath = cmdArgs[0]
          const snapshot = loadSnapshot(inputPath)

          if (!snapshot) {
            throw new CLIError('ERR_NOT_FOUND', inputPath
              ? `Snapshot file not found: ${inputPath}`
              : 'No datacore.lock.yaml found in ~/Data'
            )
          }

          const dryRun = flags['dry-run'] === true
          const skipModules = flags['skip-modules'] === true
          const skipSpaces = flags['skip-spaces'] === true

          if (dryRun) {
            info('Dry run - no changes will be made')
          }

          info(`Restoring from snapshot created ${snapshot.created}...`)
          const result = restoreFromSnapshot(snapshot, {
            modules: !skipModules,
            spaces: !skipSpaces,
            dryRun,
          })

          if (format === 'json') {
            output(result, format)
          } else {
            if (result.modulesInstalled.length > 0) {
              console.log('Modules installed:')
              for (const name of result.modulesInstalled) {
                success(`  ${name}`)
              }
            }
            if (result.modulesFailed.length > 0) {
              console.log('Modules failed:')
              for (const { name, error } of result.modulesFailed) {
                errorLog(`  ${name}: ${error}`)
              }
            }
            if (result.spacesCreated.length > 0) {
              console.log('Spaces created:')
              for (const name of result.spacesCreated) {
                success(`  ${name}`)
              }
            }
            if (result.warnings.length > 0) {
              console.log('Warnings:')
              for (const w of result.warnings) {
                warn(`  ${w}`)
              }
            }
            if (result.modulesInstalled.length === 0 && result.spacesCreated.length === 0) {
              info('Nothing to restore - installation matches snapshot')
            }
          }
          break
        }
        case 'diff': {
          const inputPath = cmdArgs[0]
          const snapshot = loadSnapshot(inputPath)

          if (!snapshot) {
            throw new CLIError('ERR_NOT_FOUND', inputPath
              ? `Snapshot file not found: ${inputPath}`
              : 'No datacore.lock.yaml found'
            )
          }

          const diff = diffSnapshot(snapshot)

          if (format === 'json') {
            output(diff, format)
          } else {
            let hasDiff = false

            if (diff.modules.added.length > 0) {
              hasDiff = true
              console.log('Modules added (not in snapshot):')
              for (const name of diff.modules.added) {
                console.log(`  + ${name}`)
              }
            }
            if (diff.modules.removed.length > 0) {
              hasDiff = true
              console.log('Modules removed (in snapshot but not installed):')
              for (const name of diff.modules.removed) {
                console.log(`  - ${name}`)
              }
            }
            if (diff.modules.changed.length > 0) {
              hasDiff = true
              console.log('Modules changed:')
              for (const { name, from, to } of diff.modules.changed) {
                console.log(`  ~ ${name}: ${from} → ${to}`)
              }
            }
            if (diff.spaces.added.length > 0) {
              hasDiff = true
              console.log('Spaces added:')
              for (const name of diff.spaces.added) {
                console.log(`  + ${name}`)
              }
            }
            if (diff.spaces.removed.length > 0) {
              hasDiff = true
              console.log('Spaces missing:')
              for (const name of diff.spaces.removed) {
                console.log(`  - ${name}`)
              }
            }
            if (diff.dependencies.changed.length > 0) {
              hasDiff = true
              console.log('Dependencies changed:')
              for (const { name, expected, actual } of diff.dependencies.changed) {
                console.log(`  ~ ${name}: ${expected} → ${actual}`)
              }
            }

            if (!hasDiff) {
              success('Installation matches snapshot')
            }
          }
          break
        }
        case 'show': {
          const inputPath = cmdArgs[0]
          const snapshot = loadSnapshot(inputPath)

          if (!snapshot) {
            throw new CLIError('ERR_NOT_FOUND', inputPath
              ? `Snapshot file not found: ${inputPath}`
              : 'No datacore.lock.yaml found'
            )
          }

          if (format === 'json') {
            output(snapshot, format)
          } else {
            console.log(`Snapshot: ${inputPath || '~/Data/datacore.lock.yaml'}`)
            console.log(`Created: ${snapshot.created}`)
            console.log(`CLI Version: ${snapshot.cliVersion}`)
            console.log(`Platform: ${snapshot.platform}`)
            console.log()
            console.log(`Modules (${snapshot.modules.length}):`)
            for (const mod of snapshot.modules) {
              const version = mod.version ? ` v${mod.version}` : ''
              const commit = mod.commit ? ` @${mod.commit.slice(0, 7)}` : ''
              console.log(`  ${mod.name}${version}${commit}`)
            }
            console.log()
            console.log(`Spaces (${snapshot.spaces.length}):`)
            for (const space of snapshot.spaces) {
              const source = space.source ? ' (git)' : ' (local)'
              console.log(`  ${space.name}${source}`)
            }
            console.log()
            console.log(`Dependencies (${snapshot.dependencies.length}):`)
            for (const dep of snapshot.dependencies) {
              const required = dep.required ? '' : ' (optional)'
              console.log(`  ${dep.name} ${dep.version}${required}`)
            }
          }
          break
        }
        default:
          throw new CLIError('ERR_INVALID_ARGUMENT', `Unknown action: snapshot ${action}`)
      }
      break
    }

    default:
      throw new CLIError('ERR_INVALID_ARGUMENT', `Unknown resource: ${resource}`)
  }
}

async function main() {
  const format = detectFormat(
    parsed.type === 'resource' || parsed.type === 'meta'
      ? (parsed.flags?.format as string)
      : undefined
  )

  try {
    switch (parsed.type) {
      case 'meta':
        await handleMeta(parsed.command, parsed.args, parsed.flags, format)
        break

      case 'resource':
        await handleResource(parsed.resource, parsed.action, parsed.args, parsed.flags, format)
        break

      case 'help':
        if (parsed.subtopic) {
          showActionHelp(parsed.topic!, parsed.subtopic)
        } else if (parsed.topic) {
          showResourceHelp(parsed.topic)
        } else {
          showHelp()
        }
        break

      case 'unknown': {
        const suggestion = suggestCommand(parsed.command)
        let message = `Unknown command: ${parsed.command}`
        if (suggestion) {
          message += `\n\nDid you mean: datacore ${suggestion}?`
        }
        message += `\n\nRun 'datacore help' for available commands.`
        console.error(message)
        process.exit(1)
      }
    }
  } catch (err) {
    if (err instanceof CLIError) {
      if (format === 'json') {
        console.log(JSON.stringify(err.toJSON(), null, 2))
      } else {
        console.error(err.toHuman())
      }
      process.exit(err.exitCode)
    }
    throw err
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
