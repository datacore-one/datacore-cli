# datacore-cli

*Last updated: 2026-02-17*

## Purpose

CLI tool (`datacore`) for installing, configuring, and managing Datacore installations. Published as `@datacore-one/cli` on npm. The init flow is the core value: it provisions `~/Data/`, clones modules, imports data sources (ChatGPT exports, etc.), and kicks off background ingest.

## Architecture

Think of it as a guided installer with ongoing management commands. `init` is stateful (saves progress to a lock file so it can resume), while other commands (`sync`, `module`, `space`, `config`) are stateless utilities.

### Components

| Component | Responsibility |
|-----------|---------------|
| `src/index.ts` | Entry point, arg dispatch, command routing |
| `src/routing.ts` | Parses args into resource/action pairs |
| `src/lib/init.ts` | Multi-step init wizard with resume support |
| `src/lib/background.ts` | Spawns detached background processes (ingest) |
| `src/lib/dependency.ts` | Doctor checks (git, bun, claude, etc.) |
| `src/lib/module.ts` | Module install/update/remove |
| `src/lib/space.ts` | Space listing and creation |
| `src/lib/sync.ts` | Pull/push/status across all spaces |
| `src/lib/snapshot.ts` | State snapshots for rollback |
| `src/state.ts` | OperationState type and lock file I/O |
| `src/config.ts` | datacore config read/write |
| `src/format.ts` | Output formatting (human vs JSON) |

### Data Flow

```
CLI invocation
  → routing.ts parses args (resource + action + flags)
  → index.ts dispatches to handler
  → lib/* executes
  → format.ts outputs result
```

Init flow specifically:
```
datacore init
  → Steps 1-8 with resume support (lock file at ~/Data/.datacore/state/init.lock)
  → Step 8: spawn background `datacore ingest` per import source (detached)
  → Background ingest runs after terminal closes
```

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Background ingest via detached spawn | Init completes quickly; heavy ingest runs post-terminal |
| Lock file for init resume | Multi-step init can fail mid-way; resume from last step |
| Version in two places | Compiled binary can't read package.json at runtime; hardcode in src/index.ts |
| Bun runtime | Fast startup, native TS, compatible with Node >=18 for distribution |
| JSON output mode (`--format json`) | Enables machine-readable output for agentic callers |

## Pitfalls

- **Version drift**: `package.json` and `VERSION` const in `src/index.ts` must be bumped together. Easy to forget one.
- **Confidence check gaps**: After adding behavior to the happy path, always verify error/fallback branches also get the change. The ChatGPT parse-failure branch was a real gap caught this way.
- **npm login masking**: `npm login` web-OTP masks the URL with `***`. Use a Granular Access Token from npmjs.com instead for any non-interactive publish flow.
- **Background process visibility**: Detached spawns are fire-and-forget. Errors from background ingest are silent to the user. Add logging to `~/Data/.datacore/state/ingest-*.log` for debugging.

## Codebase

```
datacore-cli/
├── src/
│   ├── index.ts        # Entry point and command dispatch
│   ├── routing.ts      # Arg parsing
│   ├── state.ts        # OperationState type, lock file
│   ├── config.ts       # Config read/write
│   ├── format.ts       # Output formatting
│   ├── errors.ts       # CLIError type
│   ├── help.ts         # Help text
│   └── lib/
│       ├── init.ts         # Init wizard (8 steps)
│       ├── background.ts   # spawnBackground() helper
│       ├── dependency.ts   # Doctor checks
│       ├── module.ts       # Module management
│       ├── space.ts        # Space management
│       ├── sync.ts         # Sync operations
│       ├── snapshot.ts     # State snapshots
│       └── ...
├── tests/              # Bun test suite
├── dist/               # Built output (published to npm)
├── package.json        # npm metadata (version must match src/index.ts)
├── INSTALL-SIMULATION.md  # Reference for init UX flow
└── OVERVIEW.md         # This file
```

**Entry points:**
- `src/index.ts` - Start here for any feature work
- `src/lib/init.ts` - For anything touching the install flow
- `INSTALL-SIMULATION.md` - Reference for expected UX; keep in sync with code

## Getting Started

1. `bun install` in project root
2. `bun run dev -- init --help` to test without building
3. `bun run build` to compile to `dist/`
4. `bun test` to run test suite
5. For publish: bump version in `package.json` AND `src/index.ts`, then `npm publish`
