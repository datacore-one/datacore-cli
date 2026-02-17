/**
 * Tests for configuration management.
 */

import { describe, it, expect } from 'bun:test'
import { loadConfig, getConfigValue, getAllConfig, configExists } from '../src/config'

describe('Configuration', () => {
  describe('loadConfig', () => {
    it('returns an object', () => {
      const config = loadConfig()
      expect(typeof config).toBe('object')
      expect(config).not.toBeNull()
    })

    it('includes default settings', () => {
      const config = loadConfig()
      expect(config.editor).toBeDefined()
      expect(config.sync).toBeDefined()
      expect(config.journal).toBeDefined()
    })
  })

  describe('getConfigValue', () => {
    it('returns null for non-existent key', () => {
      const result = getConfigValue('nonexistent.key.xyz')
      expect(result).toBeNull()
    })

    it('returns value with source info', () => {
      const result = getConfigValue('editor.open_markdown_on_generate')
      expect(result).not.toBeNull()
      expect(result?.key).toBe('editor.open_markdown_on_generate')
      expect(typeof result?.value).toBe('boolean')
      expect(['default', 'base', 'local']).toContain(result?.source)
    })
  })

  describe('getAllConfig', () => {
    it('returns merged config and sources', () => {
      const { merged, sources } = getAllConfig()
      expect(typeof merged).toBe('object')
      expect(typeof sources).toBe('object')
    })

    it('sources indicate origin of each value', () => {
      const { sources } = getAllConfig()
      for (const [key, source] of Object.entries(sources)) {
        expect(['default', 'base', 'local']).toContain(source)
      }
    })
  })

  describe('configExists', () => {
    it('returns a boolean', () => {
      const exists = configExists()
      expect(typeof exists).toBe('boolean')
    })
  })
})
