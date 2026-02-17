# @datacore-one/cli

CLI for setting up and managing Datacore installations - an AI-powered second brain built on GTD methodology.

## Installation

```bash
npm install -g @datacore-one/cli
```

Or run directly with npx:

```bash
npx @datacore-one/cli init
```

## Quick Start

```bash
# Set up a new Datacore installation
datacore init

# Check system status
datacore doctor

# Then use Claude Code for daily workflow
cd ~/Data && claude
```

## Commands

### Setup

- `datacore init` - Interactive setup wizard
- `datacore doctor` - Check dependencies and health
- `datacore ingest <path>` - Import files with AI processing

### Admin

- `datacore space create <name>` - Create a new space
- `datacore space list` - List all spaces
- `datacore module install <name>` - Install a module
- `datacore module list` - List modules
- `datacore module update` - Update all modules
- `datacore module remove <name>` - Remove a module
- `datacore config show` - Show settings
- `datacore config get <key>` - Get a setting
- `datacore config set <key> <value>` - Set a setting
- `datacore snapshot create` - Create installation snapshot
- `datacore snapshot restore` - Restore from snapshot

### Automation (for cron/scripts)

- `datacore sync` - Git sync all repos
- `datacore today` - Generate daily briefing
- `datacore tomorrow` - End-of-day wrap-up
- `datacore nightshift status` - Queue status
- `datacore nightshift trigger` - Execute queued AI tasks
- `datacore nightshift queue "task"` - Add task to AI queue
- `datacore cron install` - Set up scheduled tasks

## Architecture

The CLI handles **mechanical/admin** tasks:
- Setup and configuration
- Git synchronization
- Cron job management
- Module installation

**Semantic work** (file routing, knowledge extraction, task processing) is handled by Datacore agents via Claude Code.

## Development

```bash
# Install dependencies
bun install

# Run in development
bun run dev

# Run tests
bun test

# Build
bun run build
```

## License

MIT
