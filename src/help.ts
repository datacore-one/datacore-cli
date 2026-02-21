/**
 * Help system for Datacore CLI commands.
 */

import { RESOURCES, ACTIONS, type Resource } from './routing'

export function showHelp(): void {
  console.log(`datacore - AI Second Brain Setup & Management CLI

Setup and admin tool for Datacore. For daily use, run: cd ~/Data && claude

Usage:
  datacore <command> [args] [options]

Setup:
  init                 Set up a new Datacore installation
  update               Fetch latest repos, modules, check versions
  upgrade              Apply new features and configuration
  doctor               Check dependencies and system status
  ingest <path>        Import files during setup

Admin:
  space                Create and list spaces
  module               Install and manage modules
  snapshot             Create/restore installation snapshots
  config               View and modify settings

Automation (for cron jobs):
  sync                 Sync all git repos
  today                Generate daily briefing
  tomorrow             End-of-day wrap-up
  nightshift           Queue and trigger AI tasks
  cron                 Set up scheduled tasks

Meta:
  version              Show version
  help [topic]         Show help for a topic

Options:
  --format json|human  Output format (auto-detects TTY)
  --help, -h           Show help for any command
  --yes, -y            Skip confirmation prompts

Examples:
  # Initial setup
  datacore init
  datacore ingest ~/Documents/chatgpt-export/

  # Update and upgrade
  datacore update               # pull repos + modules
  datacore upgrade              # apply new features

  # Admin
  datacore snapshot create
  datacore module install nightshift

  # Then use Claude Code for daily workflow
  cd ~/Data && claude`)
}

export function showResourceHelp(resource: string): void {
  // Handle meta commands that look like resources
  if (resource === 'init') {
    showInitHelp()
    return
  }
  if (resource === 'update') {
    showUpdateHelp()
    return
  }
  if (resource === 'upgrade') {
    showUpgradeHelp()
    return
  }
  if (resource === 'doctor') {
    showDoctorHelp()
    return
  }
  if (resource === 'ingest') {
    showIngestHelp()
    return
  }
  if (resource === 'sync') {
    showSyncHelp()
    return
  }
  if (resource === 'today' || resource === 'tomorrow') {
    showGtdMetaHelp(resource)
    return
  }

  if (!RESOURCES.includes(resource as Resource)) {
    console.log(`Unknown command: ${resource}

Available commands: init, update, upgrade, doctor, ingest, sync, today, tomorrow, space, module, config, nightshift, cron, snapshot

Run 'datacore help' for overview.`)
    return
  }

  const actions = ACTIONS[resource as Resource]
  console.log(`datacore ${resource} - ${getResourceDescription(resource as Resource)}

Usage:
  datacore ${resource} <action> [args] [options]

Actions:`)

  for (const action of actions) {
    console.log(`  ${action.padEnd(18)} ${getActionDescription(resource as Resource, action)}`)
  }

  console.log(`
For detailed help on an action:
  datacore ${resource} <action> --help
  datacore help ${resource} <action>`)
}

function showUpdateHelp(): void {
  console.log(`datacore update - Fetch latest repos, modules, and versions

Usage:
  datacore update [options]

Description:
  Pulls the latest changes from all git repositories and modules.
  Also checks npm for new CLI and MCP server versions.

  Steps:
  1. Git pull all repos (root + spaces)
  2. Git pull all installed modules
  3. Check npm for new @datacore-one/cli version
  4. Check npm for new @datacore-one/mcp version

  If new npm versions are found, update them then run:
    datacore upgrade

Options:
  --skip-modules       Skip module updates
  --format json        Output as JSON

Examples:
  datacore update
  datacore update --skip-modules`)
}

function showUpgradeHelp(): void {
  console.log(`datacore upgrade - Apply new features and configuration

Usage:
  datacore upgrade [options]

Description:
  Applies structural changes from new CLI versions. Installs new
  dependencies, configures new features, and rebuilds context files.
  All steps are idempotent — safe to run repeatedly.

  Upgrade steps:
  1. Install new dependencies (e.g., MCP server)
  2. Configure MCP server for Claude Desktop and Code
  3. Ensure runtime directories exist
  4. Rebuild CLAUDE.md from layers
  5. Create fresh installation snapshot

  Typical workflow after a CLI update:
    npm update -g @datacore-one/cli
    datacore update       # pull repos + modules
    datacore upgrade      # apply new features

Options:
  --skip-deps          Skip dependency installation
  --format json        Output as JSON

Examples:
  datacore upgrade
  datacore upgrade --skip-deps`)
}

function showInitHelp(): void {
  console.log(`datacore init - Set up a new Datacore installation

Usage:
  datacore init [options]

Description:
  Interactive wizard that sets up your Datacore second brain:
  1. Creates ~/Data directory structure
  2. Installs dependencies (including MCP server)
  3. Initializes git repositories
  4. Generates CLAUDE.md context files
  5. Creates personal space (0-personal)
  6. Installs modules
  7. Configures MCP server for persistent AI memory

Options:
  --path <dir>         Installation directory (default: ~/Data)
  --yes, -y            Use defaults, skip prompts
  --no-claude          Skip Claude Code check

Examples:
  # Interactive setup
  datacore init

  # Non-interactive with defaults
  datacore init --yes

  # Custom location
  datacore init --path ~/my-data`)
}

function showDoctorHelp(): void {
  console.log(`datacore doctor - Check dependencies and system status

Usage:
  datacore doctor [options]

Description:
  Verifies all required dependencies are installed and checks
  the health of your Datacore installation.

Checks:
  Required:
    - git          Version control
    - git-lfs      Large file support
    - node >= 18   Node.js runtime
    - python >= 3.9 Python runtime

  Recommended:
    - claude       Claude Code CLI for AI features
    - datacore-mcp MCP server for persistent AI memory

  MCP Server:
    - Claude Desktop config
    - Claude Code .mcp.json

  Datacore:
    - ~/Data exists
    - .datacore/ configured
    - Spaces detected

Options:
  --format json    Output as JSON

Examples:
  datacore doctor
  datacore doctor --format json`)
}

function showIngestHelp(): void {
  console.log(`datacore ingest - Import files with AI processing

Usage:
  datacore ingest <path> [options]

Description:
  Imports files into Datacore with deep knowledge extraction.
  The CLI validates paths and invokes the ingest-coordinator agent
  which handles the 6-phase semantic processing:

  1. READ    - Analyze content
  2. ASSESS  - Determine destination
  3. EXTRACT - Pull out knowledge (zettels, insights)
  4. CAPTURE - Log tasks and TODOs
  5. FILE    - Move to semantic location
  6. LINK    - Connect to knowledge graph

Options:
  --space <name>   Target space (default: 0-personal)
  --dry-run        Show what would happen without doing it

Examples:
  # Import a file
  datacore ingest ~/Documents/report.pdf

  # Import a folder
  datacore ingest ~/Documents/export/

  # Target specific space
  datacore ingest ~/Documents/contracts/ --space 1-datafund`)
}

function showSyncHelp(): void {
  console.log(`datacore sync - Git sync for all repos

Usage:
  datacore sync [action] [options]

Actions:
  (none)           Pull all repos (default)
  push             Commit and push changes
  status           Show git status overview

Description:
  Manages git synchronization for the root Datacore repo
  and all space repositories.

Options:
  --message <msg>  Commit message (for push)

Examples:
  # Pull latest changes
  datacore sync

  # Push changes
  datacore sync push --message "Daily update"

  # Check status
  datacore sync status`)
}

function showGtdMetaHelp(command: string): void {
  if (command === 'today') {
    console.log(`datacore today - Generate daily briefing

Usage:
  datacore today [options]

Description:
  Generates your daily briefing by invoking the /today command.
  Includes:
  - Calendar events
  - Priority tasks
  - Nightshift results (completed AI tasks)
  - Journal entry

Options:
  --format json    Output as JSON

Examples:
  datacore today`)
  } else {
    console.log(`datacore tomorrow - End-of-day wrap-up

Usage:
  datacore tomorrow [options]

Description:
  Wraps up your day by invoking the /tomorrow command.
  Includes:
  - Session summary
  - Queuing AI tasks for overnight
  - Learning extraction
  - Journal update

Options:
  --format json    Output as JSON

Examples:
  datacore tomorrow`)
  }
}

export function showActionHelp(resource: string, action: string): void {
  if (!RESOURCES.includes(resource as Resource)) {
    console.log(`Unknown resource: ${resource}`)
    return
  }

  const actions = ACTIONS[resource as Resource]
  if (!actions.includes(action)) {
    console.log(`Unknown action: ${action} for ${resource}

Available actions: ${actions.join(', ')}`)
    return
  }

  const help = getDetailedHelp(resource as Resource, action)
  console.log(help)
}

function getResourceDescription(resource: Resource): string {
  const descriptions: Record<Resource, string> = {
    space: 'Create and list spaces',
    module: 'Install and manage modules',
    config: 'View and modify settings',
    nightshift: 'Queue and trigger AI tasks',
    cron: 'Manage scheduled tasks',
    snapshot: 'Create and restore installation snapshots',
  }
  return descriptions[resource]
}

function getActionDescription(resource: Resource, action: string): string {
  const descriptions: Record<string, string> = {
    // space
    'space create': 'Create a new space',
    'space list': 'List all spaces',
    // module
    'module install': 'Install a module',
    'module list': 'List installed modules',
    'module update': 'Update all modules',
    'module remove': 'Remove a module',
    // config
    'config show': 'Show all settings',
    'config get': 'Get a setting value',
    'config set': 'Set a setting value',
    // nightshift
    'nightshift status': 'Show queue and server status',
    'nightshift trigger': 'Execute queued AI tasks',
    'nightshift queue': 'Add task to AI queue',
    // cron
    'cron install': 'Install scheduled jobs',
    'cron status': 'Show job status',
    'cron remove': 'Remove scheduled jobs',
    // snapshot
    'snapshot create': 'Create installation snapshot',
    'snapshot restore': 'Restore from snapshot',
    'snapshot diff': 'Compare with snapshot',
    'snapshot show': 'Show snapshot contents',
  }
  return descriptions[`${resource} ${action}`] ?? action
}

function getDetailedHelp(resource: Resource, action: string): string {
  const key = `${resource} ${action}`

  const helpTexts: Record<string, string> = {
    'space create': `datacore space create - Create a new space

Usage:
  datacore space create [options]

Description:
  Interactive wizard to create a new team or personal space.
  Invokes the create-space agent for semantic decisions.

Options:
  --name <name>    Space name (lowercase, hyphenated)
  --type <type>    Space type: team or personal
  --yes, -y        Use defaults

Examples:
  datacore space create
  datacore space create --name fds --type team`,

    'space list': `datacore space list - List all spaces

Usage:
  datacore space list [options]

Description:
  Lists all spaces in your Datacore installation.

Options:
  --format json    Output as JSON

Examples:
  datacore space list`,

    'module install': `datacore module install - Install a module

Usage:
  datacore module install <name> [options]

Description:
  Clones a module from the Datacore catalog and registers
  its agents and commands.

Arguments:
  <name>           Module name (e.g., nightshift)

Examples:
  datacore module install nightshift
  datacore module install crm`,

    'module list': `datacore module list - List modules

Usage:
  datacore module list [options]

Description:
  Shows installed modules and available modules from catalog.

Options:
  --available      Show only available (not installed)
  --format json    Output as JSON

Examples:
  datacore module list
  datacore module list --available`,

    'config show': `datacore config show - Show all settings

Usage:
  datacore config show [options]

Description:
  Displays merged configuration from base and local settings.

Options:
  --format json    Output as JSON

Examples:
  datacore config show`,

    'config get': `datacore config get - Get a setting value

Usage:
  datacore config get <key>

Arguments:
  <key>            Setting key (e.g., sync.pull_on_today)

Examples:
  datacore config get sync.pull_on_today
  datacore config get editor.open_command`,

    'config set': `datacore config set - Set a setting value

Usage:
  datacore config set <key> <value>

Description:
  Updates settings.local.yaml with the new value.

Arguments:
  <key>            Setting key
  <value>          New value

Examples:
  datacore config set sync.pull_on_today false
  datacore config set editor.open_command code`,

    'nightshift status': `datacore nightshift status - Queue and server status

Usage:
  datacore nightshift status [options]

Description:
  Shows nightshift queue summary and server connection status.

Options:
  --format json    Output as JSON

Examples:
  datacore nightshift status`,

    'nightshift trigger': `datacore nightshift trigger - Execute queued AI tasks

Usage:
  datacore nightshift trigger

Description:
  Manually triggers execution of queued AI tasks.
  Normally called by cron job at night.

Examples:
  datacore nightshift trigger`,

    'nightshift queue': `datacore nightshift queue - Add task to AI queue

Usage:
  datacore nightshift queue "<task description>"

Description:
  Quick way to add an AI task without editing org files.
  Adds entry to inbox.org with :AI: tag.

Arguments:
  <task>           Task description

Examples:
  datacore nightshift queue "Research competitor analysis"
  datacore nightshift queue "Generate weekly metrics report"`,

    'cron install': `datacore cron install - Install scheduled jobs

Usage:
  datacore cron install [options]

Description:
  Sets up platform-specific scheduled tasks:
  - macOS: launchd plist
  - Linux: crontab entry

Options:
  --schedule <cron>  Custom schedule (default: nightly)

Examples:
  datacore cron install
  datacore cron install --schedule "0 2 * * *"`,

    'snapshot create': `datacore snapshot create - Create installation snapshot

Usage:
  datacore snapshot create [path] [options]

Description:
  Creates a snapshot of your Datacore installation including:
  - Installed modules (with git commit hashes)
  - Spaces (with git sources)
  - Dependency versions
  - Optionally: base settings

  Output: datacore.lock.yaml (like pip's requirements.txt)

Arguments:
  [path]             Output path (default: ~/Data/datacore.lock.yaml)

Options:
  --settings         Include base settings in snapshot
  --format json      Output as JSON

Examples:
  datacore snapshot create
  datacore snapshot create ./backup.lock.yaml
  datacore snapshot create --settings`,

    'snapshot restore': `datacore snapshot restore - Restore from snapshot

Usage:
  datacore snapshot restore [path] [options]

Description:
  Restores Datacore installation from a snapshot file:
  - Installs missing modules (at exact commits)
  - Creates missing spaces (if git sources available)

Arguments:
  [path]             Snapshot file (default: ~/Data/datacore.lock.yaml)

Options:
  --dry-run          Show what would be restored
  --skip-modules     Don't restore modules
  --skip-spaces      Don't restore spaces

Examples:
  datacore snapshot restore
  datacore snapshot restore ./backup.lock.yaml
  datacore snapshot restore --dry-run`,

    'snapshot diff': `datacore snapshot diff - Compare with snapshot

Usage:
  datacore snapshot diff [path] [options]

Description:
  Compares current installation with a snapshot:
  - Added/removed/changed modules
  - Added/removed spaces
  - Changed dependency versions

Arguments:
  [path]             Snapshot file (default: ~/Data/datacore.lock.yaml)

Options:
  --format json      Output as JSON

Examples:
  datacore snapshot diff
  datacore snapshot diff ./old.lock.yaml`,

    'snapshot show': `datacore snapshot show - Show snapshot contents

Usage:
  datacore snapshot show [path] [options]

Description:
  Displays the contents of a snapshot file.

Arguments:
  [path]             Snapshot file (default: ~/Data/datacore.lock.yaml)

Options:
  --format json      Output as JSON

Examples:
  datacore snapshot show
  datacore snapshot show ./backup.lock.yaml`,
  }

  return helpTexts[key] ?? `No detailed help available for: datacore ${resource} ${action}`
}
