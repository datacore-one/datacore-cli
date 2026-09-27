# Windows user: Cursor "crashed, has to be reinstalled" after a Datacore install attempt

Date: 2026-09-27. Status: open — cause not confirmed; waiting on facts from the user.

## What we know

- The user's first log is from CLI 2.5.0; install.txt then pointed them at
  `@latest` (2.6.0), which they may have run before the crash.
- The user ran `datacore init` with CLI 2.5.0 on native Windows, apparently from
  Cursor's integrated terminal. Every tool in step 2 reported "Failed to install".
- Later the user reported that Cursor crashed and has to be reinstalled.

## What our code can and cannot have done

**No version of the CLI writes to Cursor's installation or its global settings.**
- 2.5.0 (the version in the user's log) contains no Cursor-related code at all
  (checked in the published tarball).
- 2.6.0 writes Cursor config only through `.datacore/adapters/cursor/install.py`,
  into `<install>\.cursor\` — a *workspace* config that only applies when the
  user opens the Datacore folder in Cursor. It does not touch `%APPDATA%\Cursor`,
  `%LOCALAPPDATA%\Programs\cursor` or `~/.cursor/mcp.json`.

So nothing we ship can corrupt a Cursor install. Three things connected to us can
still explain the report, most serious first.

### 1. A cleanup instruction that can delete the user's home folder (our advice)

2.5.0 resolved `HOME` (unset on Windows) to the literal string `~`, so it created
a folder named `~` (holding `~\Data\.datacore\state\operations.json`) inside the
directory it ran from. On 2026-09-26 we suggested telling Cursor's agent to
"delete any leftover `Data` and `~` folders".

- PowerShell: `Remove-Item ~ -Recurse -Force` expands `~` to the HOME DIRECTORY.
- Git Bash: `rm -rf ~` does the same.

Either deletes `C:\Users\<user>` — including `AppData\Local\Programs\cursor`,
where Cursor is installed per user. That matches "Cursor crashed and has to be
reinstalled" exactly, and would also have taken documents, settings and
credentials. **This is the first thing to rule out.**

Safe removal, run from the folder that contains the stray `~`, after listing it:

```powershell
Get-ChildItem -LiteralPath '.\~'                 # must show only: Data
Remove-Item   -LiteralPath '.\~' -Recurse -Force
```

### 2. A full Datacore checkout written into the open Cursor workspace

2.5.0 also resolved `~/Data` to the relative path `Data`. If git was already
installed (likely for a Cursor user — 2.5.0's detection was broken, so its
"Failed to install git" does not mean git was missing), the clone succeeded and
the install carried on into `<workspace>\Data`: ~1,400 files (24 MB) plus every
module as a nested git repository. Cursor indexes the workspace and opens every
nested repository in its Git view. That can make Cursor hang or crash, and it
comes back every time Cursor reopens that folder — reinstalling does not clear
the "last opened folder" state, so it can look as if the reinstall didn't help.

Remedy: open a different folder in Cursor, then delete `<workspace>\Data` (only
the stray one inside the project; never `C:\Users\<user>\Data`).

### 3. An agent stuck in an interactive wizard

The old install.txt led with the interactive wizard. An agent running it in
Cursor's terminal gets a live spinner and a prompt it cannot answer. That can
hang the agent, not crash the application.

## If the user ran 2.6.0 (the version install.txt now points at)

2.6.0 installs into `C:\Users\<user>\Data`, not the current folder, and never
creates `~` or a relative `Data`. What it does that touches Cursor at all:

- When `%USERPROFILE%\.cursor` exists it runs `.datacore/adapters/cursor/install.py`,
  which writes `C:\Users\<user>\Data\.cursor\mcp.json` and `hooks.json`. Both are
  workspace files: inert unless that folder is opened in Cursor.
- `hooks.json` runs a Python guard on every `preToolUse` and `beforeShellExecution`
  (timeout 25 s, `failClosed: false`). A failing or slow guard slows the agent;
  it cannot crash the application.
- winget installs of git, Python, gh and Node LTS, only for tools that are
  missing. These installers write their own program folders and PATH.

Nothing in 2.6.0 writes to `%LOCALAPPDATA%\Programs\cursor`, `%APPDATA%\Cursor`
or `~/.cursor/mcp.json`. It cannot corrupt a Cursor install.

Windows defects found in the adapter while checking (none can crash Cursor; all
make the Cursor wiring not work on Windows):
- `hooks.json` builds `"{python} {hook.py}"` without quoting — breaks when the
  username or install path contains a space.
- `mcp.json` names `shutil.which("datacore-mcp")`, i.e. an npm `.cmd` shim, which
  a client spawning without a shell cannot launch (the CLI's own entries run
  `node.exe <script>` on Windows since 2.6.0; the adapter does not).
- The venv interpreter is looked up at `venv/bin/python`; Windows uses
  `venv\Scripts\python.exe` (it falls back to the running Python, so it works).
- The PLUR hook is looked up as `~/.plur/bin/plur-hook` with no Windows extension.

## Fixed already

- 2.5.1: HOME falls back to USERPROFILE, so no new `~` or relative `Data`
  folders are created.
- install.txt: the agent path comes first; the wizard is for a human terminal.

## To confirm with the user

1. Did anyone (them or Cursor's agent) delete a `~` folder? Is
   `C:\Users\<user>` intact (Documents, Desktop, AppData)?
2. In the folder Cursor had open, is there a `Data` folder containing
   `.datacore`? And a `~` folder?
3. Does Cursor crash only when opening that folder, or always?
4. The crash message, and the Cursor version.
