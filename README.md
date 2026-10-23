# @datacore-one/cli

Set up and manage your AI second brain.

## Why

Your AI assistant forgets everything between conversations. Your coding patterns, your domain knowledge, your project decisions -- all gone the moment you close the chat.

Datacore changes that. It gives AI assistants persistent memory, structured knowledge, and the ability to learn from every interaction. The CLI sets up the full system in minutes: knowledge base, task management, AI agents, and an MCP server that makes your AI smarter over time.

Everything lives in `~/Data` as plain text files. No databases, no vendor lock-in.

## Quick Start

```bash
curl -fsSL https://datacore.one/install | bash
```

This handles everything: installs Node.js if needed, installs the CLI, and starts the setup wizard.

Or if you already have Node.js 20+:

```bash
npm install -g @datacore-one/cli
datacore init
```

## What Gets Installed

After `datacore init`, you have:

```
~/Data/
├── .datacore/           # System config, modules, agents
├── .mcp.json            # MCP server config (auto-configured)
├── 0-personal/          # Your personal space
│   ├── org/             # GTD task management
│   ├── notes/           # Journals, pages, knowledge
│   └── 3-knowledge/     # Zettelkasten knowledge base
├── CLAUDE.md            # AI context (auto-generated)
└── sync                 # Repo sync script
```

The MCP server (`@datacore-one/mcp`) is installed and configured for both Claude Desktop and Claude Code, giving your AI structured tools for memory, learning, and knowledge capture.

## Commands

### Setup

| Command | Description |
|---------|-------------|
| `datacore init` | Interactive setup wizard |
| `datacore update` | Pull repos, install MCP, rebuild context |
| `datacore doctor` | Check dependencies, MCP config, system health |
| `datacore ingest <path>` | Import files with AI processing |
| `datacore join --prepare <machine>` | On your existing machine: register a new machine and write its join bundle |
| `datacore join <bundle>` | On the new machine: mirror the existing install (see below) |

### Admin

| Command | Description |
|---------|-------------|
| `datacore space create` | Create a new team or personal space |
| `datacore space list` | List all spaces |
| `datacore module install <name>` | Install a module |
| `datacore module list` | List installed modules |
| `datacore module update` | Update all modules |
| `datacore config show` | Show current settings |
| `datacore snapshot create` | Create installation snapshot |
| `datacore snapshot restore` | Restore from snapshot |

### A second machine: `datacore join`

One command makes a new machine a mirror of your existing installation: the
same person, the same access, so sessions there behave the same.

```bash
# on the existing machine
datacore join --prepare dayshift          # registers it, writes ~/.datacore/join/dayshift.join.yaml
scp ~/.datacore/join/dayshift.join.yaml dayshift:

# on the new machine
npx @datacore-one/cli join ~/dayshift.join.yaml
```

`--prepare` adds the machine to your private roster with its own ledger actor
(refusing one another machine already writes as) and to your principal's
hosts and writers, then writes one bundle (mode 600): the snapshot with the
private registry and the gitignored local files (`*.local.yaml` config,
`install.yaml` roles, `CLAUDE.local.md` layers). Every carried file is scanned
for secrets; a hit stops it before anything changes.

`join <bundle>` sets up root, spaces and modules from the snapshot, lands the
local files without overwriting any the machine already has (the rules of
`local_files_sync.py`), registers the machine, writes
`~/.datacore/identity.env`, and joins the credential store. Credentials are
granted on the store side only: the new machine prints its public key and
the steps for you, waits, then clones the store and runs `creds sync` and
`creds doctor`. It ends with checks (identity, branches, clean spaces,
`datacore doctor`) and a list of anything left to do. Running it again
continues where it stopped.

### Automation

| Command | Description |
|---------|-------------|
| `datacore sync` | Git sync all repos |
| `datacore today` | Generate daily briefing |
| `datacore tomorrow` | End-of-day wrap-up |
| `datacore nightshift trigger` | Execute queued AI tasks |
| `datacore cron install` | Set up scheduled tasks |

## After Setup

```bash
cd ~/Data && claude
```

This starts Claude Code with full access to your second brain. The MCP server provides structured tools for:

- **Learning** -- create engrams that persist across conversations
- **Journaling** -- capture daily entries and knowledge notes
- **Searching** -- find anything in your knowledge base
- **Task management** -- GTD workflow with AI delegation

## Architecture

The CLI handles **setup and admin**: installing dependencies, configuring repos, managing modules, and setting up the MCP server.

**Daily work** happens through Claude Code, which uses the MCP server and Datacore agents for semantic tasks like file routing, knowledge extraction, and task processing.

## Development

```bash
bun install
bun run dev          # Run in development
bun test             # Run tests (76 tests)
bun run build        # Build for distribution
```

## License

MIT
