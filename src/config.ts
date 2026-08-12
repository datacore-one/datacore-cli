/**
 * Configuration management for Datacore.
 * Handles layered settings (base + local).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { parse, stringify } from 'yaml'
import type { ConfigValue } from './types'
import { dataDir } from './lib/paths'

const DATA_DIR = () => dataDir()
const CONFIG_DIR = join(DATA_DIR(), '.datacore')
const BASE_CONFIG = join(CONFIG_DIR, 'settings.yaml')
const LOCAL_CONFIG = join(CONFIG_DIR, 'settings.local.yaml')

// Default settings
const DEFAULTS: Record<string, unknown> = {
  editor: {
    open_markdown_on_generate: true,
    open_command: '',
  },
  sync: {
    pull_on_today: true,
    push_on_wrap_up: true,
  },
  journal: {
    open_after_update: false,
  },
  nightshift: {
    server: '',
    auto_trigger: false,
  },
}

function loadYaml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    const content = readFileSync(path, 'utf-8')
    return (parse(content) as Record<string, unknown>) ?? {}
  } catch {
    return {}
  }
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const sourceVal = source[key]
    const targetVal = result[key]
    if (
      typeof sourceVal === 'object' &&
      sourceVal !== null &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === 'object' &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(targetVal as Record<string, unknown>, sourceVal as Record<string, unknown>)
    } else {
      result[key] = sourceVal
    }
  }
  return result
}

export function loadConfig(): Record<string, unknown> {
  const base = loadYaml(BASE_CONFIG)
  const local = loadYaml(LOCAL_CONFIG)
  return deepMerge(deepMerge(DEFAULTS, base), local)
}

export function getConfigValue(key: string): ConfigValue | null {
  const parts = key.split('.')
  const config = loadConfig()
  const base = loadYaml(BASE_CONFIG)
  const local = loadYaml(LOCAL_CONFIG)

  // Navigate to the value
  let value: unknown = config
  for (const part of parts) {
    if (typeof value !== 'object' || value === null) return null
    value = (value as Record<string, unknown>)[part]
  }

  if (value === undefined) return null

  // Determine source
  let source: ConfigValue['source'] = 'default'
  let checkValue: unknown = local
  for (const part of parts) {
    if (typeof checkValue !== 'object' || checkValue === null) break
    checkValue = (checkValue as Record<string, unknown>)[part]
  }
  if (checkValue !== undefined) source = 'local'
  else {
    checkValue = base
    for (const part of parts) {
      if (typeof checkValue !== 'object' || checkValue === null) break
      checkValue = (checkValue as Record<string, unknown>)[part]
    }
    if (checkValue !== undefined) source = 'base'
  }

  return { key, value, source }
}

export function setConfigValue(key: string, value: string): void {
  const parts = key.split('.')
  if (parts.length === 0) return

  // Load or create local config
  let local = loadYaml(LOCAL_CONFIG)

  // Parse value (try to convert to appropriate type)
  let parsedValue: unknown = value
  if (value === 'true') parsedValue = true
  else if (value === 'false') parsedValue = false
  else if (/^\d+$/.test(value)) parsedValue = parseInt(value, 10)
  else if (/^\d+\.\d+$/.test(value)) parsedValue = parseFloat(value)

  // Navigate and set
  let current = local
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!part) continue
    if (typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }

  const lastPart = parts[parts.length - 1]
  if (lastPart) {
    current[lastPart] = parsedValue
  }

  // Ensure directory exists
  if (!existsSync(dirname(LOCAL_CONFIG))) {
    mkdirSync(dirname(LOCAL_CONFIG), { recursive: true })
  }

  // Write local config
  writeFileSync(LOCAL_CONFIG, stringify(local))
}

export function getAllConfig(): { merged: Record<string, unknown>; sources: Record<string, string> } {
  const merged = loadConfig()
  const base = loadYaml(BASE_CONFIG)
  const local = loadYaml(LOCAL_CONFIG)

  const sources: Record<string, string> = {}

  function traceSources(obj: Record<string, unknown>, path: string[] = []): void {
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = [...path, key]
      const pathStr = currentPath.join('.')

      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        traceSources(value as Record<string, unknown>, currentPath)
      } else {
        // Check if in local
        let check: unknown = local
        for (const p of currentPath) {
          if (typeof check !== 'object' || check === null) {
            check = undefined
            break
          }
          check = (check as Record<string, unknown>)[p]
        }
        if (check !== undefined) {
          sources[pathStr] = 'local'
          continue
        }

        // Check if in base
        check = base
        for (const p of currentPath) {
          if (typeof check !== 'object' || check === null) {
            check = undefined
            break
          }
          check = (check as Record<string, unknown>)[p]
        }
        if (check !== undefined) {
          sources[pathStr] = 'base'
          continue
        }

        sources[pathStr] = 'default'
      }
    }
  }

  traceSources(merged)
  return { merged, sources }
}

export function configExists(): boolean {
  return existsSync(CONFIG_DIR)
}
