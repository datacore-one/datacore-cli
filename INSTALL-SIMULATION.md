# Datacore Init - Install Simulation (v2)

Simulated output of `datacore init` for a completely new user.
**Scenario**: Fresh macOS or Linux machine, only Homebrew installed. User has never seen Datacore.
User inputs shown as `>>> input`.

**Design principles**:
- The installer handles EVERYTHING - user never leaves to install things manually
- All dependencies auto-installed (Claude Code first - it's the core)
- Defaults are sensible (modules: all on, use case: both)
- Educational content at each step explains concepts
- Ends with data ingestion - user leaves setup with content already in the system
- `datacore start` = single entry point (cd ~/Data && claude). Project settings handle permissions


## Pre-install

**Prerequisite**: Node.js 20+ (`node --version` to check, install from https://nodejs.org). Required to run `npm install`. The installer will verify and suggest upgrading if outdated.

```
$ npm install -g @datacore-one/cli
$ datacore init
```


## Banner

```

    ██████╗  █████╗ ████████╗ █████╗  ██████╗ ██████╗ ██████╗ ███████╗
    ██╔══██╗██╔══██╗╚══██╔══╝██╔══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝
    ██║  ██║███████║   ██║   ███████║██║     ██║   ██║██████╔╝█████╗
    ██║  ██║██╔══██║   ██║   ██╔══██║██║     ██║   ██║██╔══██╗██╔══╝
    ██████╔╝██║  ██║   ██║   ██║  ██║╚██████╗╚██████╔╝██║  ██║███████╗
    ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝

                    AI-Powered Second Brain

  Setting up your AI-powered second brain...
```


## Step 1/9: About You

```
▸ Step 1/9: About You
──────────────────────────────────────────────────

  Let's personalize your setup. This configures your identity,
  AI context layer, and tailors the experience to your needs.

  Your name: >>> Alice Smith
  Your email: >>> alice@example.com

  How will you use Datacore?
     1) Personal productivity (GTD, knowledge management, AI delegation)
     2) Team management (projects, collaboration, shared knowledge)
   > 3) Both personal and team use

  Choose [3]: >>> <enter>

  Your role (e.g., developer, founder, researcher): >>> founder

  ✓ Welcome, Alice!
```


## Step 2/9: System Setup

```
▸ Step 2/9: System Setup
──────────────────────────────────────────────────

  Ensuring all tools are installed and configured.
  Datacore will install anything that's missing.

  ✓ git (2.43.0)
  ⠋ Configuring git identity...
  ✓ Git configured as: Alice Smith <alice@example.com>
  ✓ node (22.2.0)
  ⠋ Installing Claude Code...
  ✓ Claude Code installed (1.0.12)
  ✓ python (3.12.3)
  ⠋ Installing GitHub CLI...
  ✓ GitHub CLI installed (2.62.0)

    To connect your GitHub account, a browser window will open.
  Authenticate with GitHub now? [Y/n]: >>> <enter>

  ✓ GitHub authenticated (alice)
  ⠋ Installing git-lfs...
  ✓ git-lfs installed (3.4.1)

  All systems ready.
```

### Variant: Everything already installed

```
  ✓ git (2.43.0)
    Configured as: Alice Smith <alice@example.com>
  ✓ node (22.2.0)
  ✓ Claude Code (1.0.12)
  ✓ python (3.12.3)
  ✓ GitHub CLI (authenticated as alice)
  ✓ git-lfs (3.4.1)

  All systems ready.
```

### Variant: Fresh Linux machine (more installs needed)

```
  ⠋ Installing git...
  ✓ git installed (2.43.0)
  ⠋ Configuring git identity...
  ✓ Git configured as: Alice Smith <alice@example.com>
  ⠋ Installing node...
  ✓ node installed (22.2.0)
  ⠋ Installing Claude Code...
  ✓ Claude Code installed (1.0.12)
  ⠋ Installing python...
  ✓ python installed (3.12.3)
  ⠋ Installing GitHub CLI...
  ✓ GitHub CLI installed (2.62.0)

  Authenticate with GitHub now? [Y/n]: >>> y
  ✓ GitHub authenticated (alice)
  ⠋ Installing git-lfs...
  ✓ git-lfs installed (3.4.1)

  All systems ready.
```

### Variant: Homebrew not installed (macOS)

```
  Homebrew is needed to install system packages on macOS.

  ⠋ Installing Homebrew...
  ✓ Homebrew installed

  ⠋ Installing git...
  ...
```

### Variant: Git already configured with different identity

```
  ✓ git (2.43.0)
    Git configured as: Alice <alice@work.com>
    Update to Alice Smith <alice@example.com>? [y/N]: >>> n
  ✓ node (22.2.0)
  ...
```


## Step 3/9: Setting Up Repository

```
▸ Step 3/9: Setting Up Repository
──────────────────────────────────────────────────

  Datacore lives in ~/Data. We'll fork the main repository to your
  GitHub account so you can customize freely and pull updates.

  ⠋ Forking repository...
  ✓ Forked to alice/datacore
  ⠋ Cloning into ~/Data...
  ✓ Cloned into ~/Data
  ⠋ Fetching specifications...
  ✓ Specifications installed
  ✓ Git LFS initialized
```

### Variant: Re-run (already installed)

```
  ✓ Found existing repository at ~/Data
  ✓ Repository up to date
  ✓ Specifications present
```


## Step 4/9: Team Spaces

```
▸ Step 4/9: Team Spaces
──────────────────────────────────────────────────

  Spaces separate different areas of your life. Your personal space
  (0-personal) is created automatically. Team spaces are separate
  git repos for organizations you work with.

  Each team space gets its own:
    • GTD task system and AI agents
    • Knowledge base (wiki, notes, research)
    • Project tracking via GitHub Issues

  Would you like to add a team space? [y/N]: >>> y

  Space name (e.g., "datafund", "acme-corp"): >>> datafund
  ✓ Found registered space: Datafund
    Datafund organization - strategy, operations, investor relations
  ⠋ Cloning Datafund...
  ✓ Added space: 1-datafund

  Add another? [y/N]: >>> y

  Space name (e.g., "datafund", "acme-corp"): >>> fds
  ✓ Found registered space: Fair Data Society
    FDS projects - Fairdrive, Fairdrop, fairOS, identity
  ⠋ Cloning Fair Data Society...
  ✓ Added space: 2-fds

  Add another? [y/N]: >>> n
```

### Variant: Private repo access denied

```
  Space name (e.g., "datafund", "acme-corp"): >>> datafund
  ✓ Found registered space: Datafund
    Datafund organization - strategy, operations, investor relations
  ⠋ Cloning Datafund...
  ✗ Could not clone Datafund
    This is a private repo. Make sure you have access to datacore-one.
    Request access or try: gh auth refresh -s read:org

  Add another? [y/N]: >>> n
```

### Variant: Custom space (not in registry)

```
  Space name (e.g., "datafund", "acme-corp"): >>> acme-corp
  Git repo URL (or Enter to create local): >>> https://github.com/acme/team-space.git
  ⠋ Cloning acme-corp...
  ✓ Added space: 1-acme-corp

  Add another? [y/N]: >>> n
```

### Variant: Create local space (no URL)

```
  Space name (e.g., "datafund", "acme-corp"): >>> acme-corp
  Git repo URL (or Enter to create local): >>> <enter>
  ✓ Created acme-corp/

  Add another? [y/N]: >>> n
```

### Variant: "personal" use case selected in Step 1

```
▸ Step 4/9: Team Spaces
──────────────────────────────────────────────────

  Spaces separate different areas of your life. Your personal space
  (0-personal) is set up automatically.

  You selected personal use. You can add team spaces anytime later:
    datacore space create <name>
```


## Step 5/9: Your Second Brain

```
▸ Step 5/9: Your Second Brain
──────────────────────────────────────────────────

  You interact with Datacore through Claude Code - just talk
  naturally. Claude manages all the files, tasks, and agents for you.

  Three systems work together:

  GTD (Getting Things Done)
  Capture anything → Claude processes it → you review and decide.
  Delegate tasks to AI agents that work in the background.

  Knowledge Management
  Every note, conversation, and document feeds your personal
  knowledge base. The more you capture, the smarter it gets.

  AI Agents
  Specialized agents handle research, writing, data analysis,
  and project management. You just describe what you need.

  ✓ Personal space ready (0-personal/)
  ✓ GTD system initialized
  ✓ Knowledge base ready
  ✓ Templates activated
  ✓ CLAUDE.local.md created (your private AI context)
  ✓ settings.local.yaml created (your preferences)

  Checking for markdown editor...
  ✓ Obsidian detected
```

### Variant: No markdown editor found

```
  Checking for markdown editor...
  ○ No markdown editor found

  Your knowledge base uses markdown files. We recommend Typora:
    https://typora.io
  You can also use VS Code, Obsidian, or any text editor.
```


## Step 6/9: Modules

```
▸ Step 6/9: Modules
──────────────────────────────────────────────────

  Modules extend Datacore with specialized capabilities. Each adds
  new AI agents and /commands you can use in Claude Code.

  All modules are selected by default. Deselect any you don't need:

  [x]  1. nightshift   Autonomous AI task execution (local mode) (core)
  [x]  2. health       Health and wellness tracking - sleep, exercise, habits
  [x]  3. crm          Network intelligence and contact management
  [x]  4. meetings     Meeting lifecycle automation
  [x]  5. mail         Email integration and processing
  [x]  6. news         Automated news aggregation with AI-scored relevance
  [x]  7. slides       Presentation generation via Gamma.app
  [ ]  8. trading      Position management and trading workflows
  [x]  9. telegram     Mobile access to Claude Code via Telegram
  [x] 10. campaigns    Landing pages, deployment, and A/B testing

  Enter numbers to REMOVE, or press Enter to install all: >>> 8

  ⠋ Installing nightshift...
  ✓ nightshift
  ⠋ Installing health...
  ✓ health
  ⠋ Installing crm...
  ✓ crm
  ⠋ Installing meetings...
  ✓ meetings
  ⠋ Installing mail...
  ✓ mail - dependencies installed (pip)
  ⠋ Installing news...
  ✓ news
  ⠋ Installing slides...
  ✓ slides - dependencies installed (npm)
  ⠋ Installing telegram...
  ✓ telegram
  ⠋ Installing campaigns...
  ✓ campaigns

  9 modules installed.
```

### Variant: User deselects several

```
  Enter numbers to REMOVE, or press Enter to install all: >>> 6,7,8,9,10

  ⠋ Installing nightshift...
  ✓ nightshift
  ⠋ Installing health...
  ✓ health
  ⠋ Installing crm...
  ✓ crm
  ⠋ Installing meetings...
  ✓ meetings
  ⠋ Installing mail...
  ✓ mail - dependencies installed (pip)

  5 modules installed.
```


## Step 7/9: Finalize

```
▸ Step 7/9: Finalize
──────────────────────────────────────────────────

  ✓ CLAUDE.md built from layers (all spaces)
  ✓ Claude Code permissions configured (acceptEdits mode)
  ✓ Knowledge database initialized
  ✓ Runtime directories ready
  ✓ Sync script configured
  ✓ install.yaml saved
  ✓ Snapshot created (datacore.lock.yaml)

  Claude Code is configured to auto-accept file edits and pre-approve
  common tools (git, npm, python). Change in .datacore/settings.json.
```


## Step 8/9: Import Your Data

```
▸ Step 8/9: Import Your Data
──────────────────────────────────────────────────

  Your second brain works best when it has your existing knowledge.
  You can import data now or do it later with 'datacore ingest'.

  Common sources to import:
    1) ChatGPT conversation exports (JSON)
    2) Documents folder (PDFs, Word docs, markdown)
    3) Existing notes (Obsidian, Notion export, etc.)
    4) Skip for now

  What would you like to import? [4]: >>> 1

  Path to ChatGPT export: >>> ~/Downloads/conversations.json
  ⠋ Processing ChatGPT export...
  ✓ Found 47 conversations - queued for background processing

  Import more? [y/N]: >>> y

  Common sources to import:
    1) ChatGPT conversation exports (JSON)
    2) Documents folder (PDFs, Word docs, markdown)
    3) Existing notes (Obsidian, Notion export, etc.)
    4) Skip for now

  What would you like to import? [4]: >>> 2

  Path to documents: >>> ~/Documents/Work
  ⠋ Scanning ~/Documents/Work...
  ✓ Found 34 files (12 .pdf, 8 .docx, 14 .md)
  ⠋ Copying to inbox...
  ✓ 34 files queued for background processing

  Import more? [y/N]: >>> n
```

### Variant: User skips

```
  What would you like to import? [4]: >>> 4

  No problem! You can import data anytime:
    datacore ingest ~/path/to/files
```


## Step 9/9: Verification

```
▸ Step 9/9: Verification
──────────────────────────────────────────────────

  Running AI verification to check everything is configured correctly...

  ⠋ Claude Code structural integrity check...
  ✓ All checks passed

    Spaces:     3 (0-personal, 1-datafund, 2-fds)
    Modules:    9 installed
    Import:     81 files in inbox
```


## Success Screen

```
    ╔══════════════════════════════════════════════════════════╗
    ║                                                          ║
    ║   ██  D A T A C O R E   S Y S T E M   O N L I N E  ██   ║
    ║          ▸ All systems nominal. Ready to engage. ◂       ║
    ║                                                          ║
    ╚══════════════════════════════════════════════════════════╝

  Setup Complete, Alice!

  Your Datacore:
    👤 0-personal
    👥 1-datafund
    👥 2-fds

  Modules: nightshift, health, crm, meetings, mail, news,
           slides, telegram, campaigns

  Background imports:
    ✓ ingest processing
    ✓ ingest processing
    Check progress: datacore status

  Your Daily Workflow:

    /today          Morning briefing - priorities, calendar, AI results
    /wrap-up        End of day - process inbox, delegate to AI agents
    /continue       Resume where you left off in any session
    /tomorrow       Plan tomorrow, queue overnight AI tasks

  Getting Started with Claude:
  You need an Anthropic API key or Claude Max subscription.
  Get your key at https://console.anthropic.com, then:
    datacore start
    "Help me configure my API keys"
  Keys are stored locally in .datacore/env/ and never leave your machine.

  Email Integration:
  Connect your email when you're ready:
    "Help me connect my Gmail" in Claude Code

  Get Started:

    datacore start

  Edit ~/Data/CLAUDE.local.md to teach Claude about you.
  Run 'datacore doctor' anytime to check system health.
```


## Generated Files

### ~/Data/.claude/settings.json
```json
{
  "defaultMode": "acceptEdits",
  "permissions": {
    "allow": [
      "Bash(git *)",
      "Bash(npm *)",
      "Bash(python*)",
      "Bash(node *)",
      "Bash(bun *)",
      "Bash(gh *)",
      "Bash(datacore *)",
      "Bash(mkdir *)",
      "Bash(cp *)",
      "Bash(mv *)",
      "Bash(chmod *)",
      "Bash(cat *)",
      "Bash(ls *)",
      "Read",
      "Edit",
      "Write",
      "Grep",
      "Glob",
      "WebFetch",
      "WebSearch"
    ],
    "deny": [
      "Bash(sudo *)",
      "Bash(rm -rf /)"
    ]
  }
}
```

**Why `acceptEdits` instead of `--dangerously-skip-permissions`:**
- Auto-accepts file edits (no "edit this?" prompts)
- Pre-approved commands (git, npm, python, etc.) run without asking
- Still prompts for unrecognized Bash commands (safety net)
- Deny rules block dangerous operations
- Persists across sessions - no flags needed on `datacore start`
- `.claude/` is a symlink to `.datacore/`, so this lives at `.datacore/settings.json`

### ~/Data/CLAUDE.local.md
```markdown
<!-- PRIVATE LAYER - This file is gitignored and never shared -->

# Alice's Datacore

Role: founder

## My Workflow

<!-- Add your personal workflow notes, preferences, and shortcuts here. -->
<!-- This file is gitignored and only visible to your local Claude Code. -->

## Custom Context

<!-- Any private context that helps Claude assist you better: -->
<!-- - Project abbreviations and shorthand -->
<!-- - Personal communication preferences -->
<!-- - Domain expertise and background -->
```

### ~/Data/install.yaml
```yaml
# Datacore Installation Manifest
# Generated by: datacore init
# Date: 2026-02-17

meta:
  name: "Alice's Datacore"
  root: /home/alice/Data
  version: 1.0.0
  role: "founder"
  use_case: both

modules:
  - nightshift
  - health
  - crm
  - meetings
  - mail
  - news
  - slides
  - telegram
  - campaigns

personal:
  path: 0-personal

spaces:
  1-datafund:
    path: 1-datafund
  2-fds:
    path: 2-fds
```

### ~/Data/datacore.lock.yaml (snapshot)
```yaml
version: "1.0"
created: "2026-02-17T10:30:00Z"
cliVersion: "1.0.6"
platform: "darwin (24.2.0)"

modules:
  - name: nightshift
    source: https://github.com/datacore-one/datacore-nightshift
    commit: a1b2c3d
  - name: crm
    source: https://github.com/datacore-one/datacore-crm
    commit: e4f5g6h
  # ...

spaces:
  - name: 0-personal
    type: personal
  - name: 1-datafund
    type: team
    source: https://github.com/datacore-one/datafund-space.git
    commit: i7j8k9l
  - name: 2-fds
    type: team
    source: https://github.com/fairDataSociety/fds-space.git
    commit: m2n3o4p

dependencies:
  - name: git
    version: "2.43.0"
  - name: claude
    version: "1.0.12"
  - name: node
    version: "22.2.0"
  - name: python
    version: "3.12.3"
  - name: gh
    version: "2.62.0"
  - name: git-lfs
    version: "3.4.1"
```


## Flow Summary

| Step | Name | Duration | Interactive |
|------|------|----------|-------------|
| 1 | About You | ~15s | Yes (name, email, role) |
| 2 | System Setup | ~120-300s | Minimal (gh auth, homebrew) |
| 3 | Repository | ~30s | No |
| 4 | Team Spaces | ~15s | Yes (search by name) |
| 5 | Your Second Brain | ~5s | No (brief education + editor check) |
| 6 | Modules | ~60-120s | Yes (deselect unwanted) |
| 7 | Finalize | ~15s | No |
| 8 | Import Data | ~30s | Yes (select sources) |
| 9 | Verification | ~30s | No |

**Total: ~8-15 minutes** (fresh install with Homebrew, import runs in background)
**Re-run: ~1-2 minutes** (everything cached/installed)


## Key Design Decisions

1. **About You first** - We need name/email to configure git, personalize files
2. **Auto-install everything** - User never leaves the installer. git, Claude Code, python, gh, git-lfs all auto-installed. Node.js is a prerequisite (needed for npm install of CLI)
3. **Git auto-configured** - Uses name/email from Step 1
4. **Team spaces before modules** - User thinks about their world first, tools second
5. **Space search, not catalog** - Known spaces (Datafund, FDS, Datacore) matched by typing name, not displayed as a list. Keeps setup clean, scales well, doesn't expose org structure. Custom URLs always accepted.
6. **Modules default ALL** - 10 modules, deselect what you don't want. Nightshift is core (local mode, no VPS)
7. **Claude is the interface** - Step 5 emphasizes user talks to Claude, not edits files. Brief, conceptual education
8. **Background import** - User selects sources (ChatGPT, docs, notes) during init, processing runs in background. Email connection deferred to post-install to build trust first
9. **Markdown editor check** - Detects Obsidian/Typora/VS Code, suggests Typora if none found
10. **Daily workflow prominent** - Success screen highlights /today → /wrap-up → /continue → /tomorrow cycle
11. **API keys via Claude** - Not manual file editing. "Help me configure my API keys" in Claude Code
12. **Snapshot on finish** - Reproducible baseline for restore/migration
13. **No dead ends** - Every "missing" scenario is handled by auto-installing
14. **Anthropic API key noted** - Success screen mentions the requirement for an API key or Claude Max subscription
15. **Git identity respected** - If git is already configured with different identity, asks before overriding


## Re-run Behavior

Running `datacore init` again is safe. Each step handles existing state:

| Step | Re-run Behavior |
|------|-----------------|
| 1 | Re-asks name/email (pre-fills from install.yaml) |
| 2 | Skips installed dependencies, verifies versions |
| 3 | Pulls latest instead of cloning |
| 4 | Shows existing spaces, allows adding more |
| 5 | Skips if personal space exists |
| 6 | Skips already-installed modules, installs new selections |
| 7 | Rebuilds CLAUDE.md, updates install.yaml |
| 8 | Independent - can import new sources each run |
| 9 | Always runs verification |

**Partial failure recovery**: If init crashes mid-step, re-run it. Each step checks existing state before acting. No `--resume` flag needed.
