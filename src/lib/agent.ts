/**
 * Agent Invoker - Call Datacore agents via Claude Code.
 *
 * Agents are invoked through Claude Code using the Task tool,
 * which spawns subagents with specific system prompts.
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import type { AgentInvocation, AgentResult } from '../types'
import { dataDir } from './paths'

const DATA_DIR = () => dataDir()

function commandExists(cmd: string): boolean {
  try {
    const { execSync } = require('child_process')
    execSync(`which ${cmd}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export interface InvokeOptions {
  /** Stream output to console as it arrives */
  stream?: boolean
  /** Working directory (defaults to ~/Data) */
  cwd?: string
  /** Timeout in milliseconds */
  timeout?: number
}

/**
 * Invoke a Datacore agent via Claude Code.
 *
 * This uses Claude Code's subprocess mode to run an agent,
 * passing the agent name and parameters as a prompt.
 */
export async function invokeAgent(
  invocation: AgentInvocation,
  options: InvokeOptions = {}
): Promise<AgentResult> {
  const { stream = false, cwd = DATA_DIR(), timeout = 300000 } = options

  // Verify claude command exists
  if (!commandExists('claude')) {
    return {
      success: false,
      output: '',
      error: 'Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code',
    }
  }

  // Verify working directory exists
  if (!existsSync(cwd)) {
    return {
      success: false,
      output: '',
      error: `Working directory not found: ${cwd}`,
    }
  }

  // Build the prompt that will invoke the agent
  const prompt = buildAgentPrompt(invocation)

  return new Promise((resolve) => {
    const chunks: string[] = []
    let errorChunks: string[] = []
    let timedOut = false

    // Use claude with --print flag for non-interactive mode
    const proc = spawn('claude', ['--print', prompt], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Ensure Claude Code knows we're in a non-interactive context
        CI: 'true',
      },
    })

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
    }, timeout)

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      chunks.push(text)
      if (stream) {
        process.stdout.write(text)
      }
    })

    proc.stderr?.on('data', (data: Buffer) => {
      errorChunks.push(data.toString())
    })

    proc.on('close', (code) => {
      clearTimeout(timer)

      const output = chunks.join('')
      const stderr = errorChunks.join('')

      if (timedOut) {
        resolve({
          success: false,
          output,
          error: `Agent timed out after ${timeout}ms`,
        })
        return
      }

      if (code !== 0) {
        resolve({
          success: false,
          output,
          error: stderr || `Agent exited with code ${code}`,
        })
        return
      }

      // Parse artifacts from output if present
      const artifacts = parseArtifacts(output)

      resolve({
        success: true,
        output,
        artifacts: Object.keys(artifacts).length > 0 ? artifacts : undefined,
      })
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        success: false,
        output: chunks.join(''),
        error: err.message,
      })
    })
  })
}

/**
 * Build a prompt that instructs Claude Code to invoke a specific agent.
 */
function buildAgentPrompt(invocation: AgentInvocation): string {
  const { agent, params } = invocation

  // Format parameters as readable key-value pairs
  const paramLines = Object.entries(params)
    .map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
    .join('\n')

  return `Use the Task tool to invoke the "${agent}" agent with the following parameters:

${paramLines || '(no parameters)'}

Wait for the agent to complete and return its results.`
}

/**
 * Parse artifact markers from agent output.
 * Artifacts are marked with: <!-- ARTIFACT:name:path -->
 */
function parseArtifacts(output: string): Record<string, string> {
  const artifacts: Record<string, string> = {}
  const regex = /<!-- ARTIFACT:([^:]+):([^ ]+) -->/g
  let match

  while ((match = regex.exec(output)) !== null) {
    const [, name, path] = match
    if (name && path) {
      artifacts[name] = path
    }
  }

  return artifacts
}

/**
 * List available agents by scanning the registry.
 */
export function listAgents(): string[] {
  const registryPath = join(DATA_DIR(), '.datacore', 'registry', 'agents.yaml')
  if (!existsSync(registryPath)) {
    return []
  }

  try {
    const { readFileSync } = require('fs')
    const { parse } = require('yaml')
    const content = readFileSync(registryPath, 'utf-8')
    const registry = parse(content) as { agents?: Array<{ name: string }> }
    return registry.agents?.map((a) => a.name) || []
  } catch {
    return []
  }
}

/**
 * Check if a specific agent exists.
 */
export function agentExists(name: string): boolean {
  return listAgents().includes(name)
}
