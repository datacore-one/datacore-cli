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
