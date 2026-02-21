/**
 * Platform detection utilities.
 */

import { execSync } from 'child_process'
import { platform, arch, release } from 'os'

export type Platform = 'macos' | 'linux' | 'wsl' | 'windows' | 'unknown'

export function detectPlatform(): Platform {
  const p = platform()

  if (p === 'darwin') return 'macos'
  if (p === 'win32') return 'windows'
  if (p === 'linux') {
    // Check for WSL
    try {
      const uname = execSync('uname -r', { encoding: 'utf-8' }).toLowerCase()
      if (uname.includes('microsoft') || uname.includes('wsl')) {
        return 'wsl'
      }
    } catch {
      // Ignore
    }
    return 'linux'
  }

  return 'unknown'
}

export function getPlatformInfo(): { platform: Platform; arch: string; release: string } {
  return {
    platform: detectPlatform(),
    arch: arch(),
    release: release(),
  }
}

export function getInstallCommand(pkg: string, platform: Platform): string | null {
  const commands: Record<string, Record<Platform, string | null>> = {
    git: {
      macos: 'brew install git',
      linux: 'sudo apt-get install git',
      wsl: 'sudo apt-get install git',
      windows: 'winget install Git.Git',
      unknown: null,
    },
    'git-lfs': {
      macos: 'brew install git-lfs && git lfs install',
      linux: 'sudo apt-get install git-lfs && git lfs install',
      wsl: 'sudo apt-get install git-lfs && git lfs install',
      windows: 'winget install GitHub.GitLFS',
      unknown: null,
    },
    node: {
      macos: 'brew install node',
      linux: 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs',
      wsl: 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs',
      windows: 'winget install OpenJS.NodeJS',
      unknown: null,
    },
    python: {
      macos: 'brew install python@3.11',
      linux: 'sudo apt-get install python3',
      wsl: 'sudo apt-get install python3',
      windows: 'winget install Python.Python.3.11',
      unknown: null,
    },
    gh: {
      macos: 'brew install gh',
      linux: 'sudo apt-get install gh',
      wsl: 'sudo apt-get install gh',
      windows: 'winget install GitHub.cli',
      unknown: null,
    },
    claude: {
      macos: 'npm install -g @anthropic-ai/claude-code',
      linux: 'npm install -g @anthropic-ai/claude-code',
      wsl: 'npm install -g @anthropic-ai/claude-code',
      windows: 'npm install -g @anthropic-ai/claude-code',
      unknown: 'npm install -g @anthropic-ai/claude-code',
    },
    'datacore-mcp': {
      macos: 'npm install -g @datacore-one/mcp',
      linux: 'npm install -g @datacore-one/mcp',
      wsl: 'npm install -g @datacore-one/mcp',
      windows: 'npm install -g @datacore-one/mcp',
      unknown: 'npm install -g @datacore-one/mcp',
    },
  }

  return commands[pkg]?.[platform] ?? null
}
