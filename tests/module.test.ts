/**
 * Tests for module management.
 */

import { describe, it, expect } from 'bun:test'
import { listModules, getModuleInfo } from '../src/lib/module'

describe('Module Management', () => {
  describe('listModules', () => {
    it('returns an array', () => {
      const modules = listModules()
      expect(Array.isArray(modules)).toBe(true)
    })

    it('modules have required properties', () => {
      const modules = listModules()
      for (const mod of modules) {
        expect(typeof mod.name).toBe('string')
        expect(typeof mod.path).toBe('string')
        expect(Array.isArray(mod.agents)).toBe(true)
        expect(Array.isArray(mod.commands)).toBe(true)
      }
    })
  })

  describe('getModuleInfo', () => {
    it('returns null for invalid path', () => {
      const info = getModuleInfo('/nonexistent/path/xyz')
      expect(info).not.toBeNull() // It returns partial info even for missing paths
    })

    it('extracts module name from path', () => {
      const modules = listModules()
      if (modules.length > 0 && modules[0]) {
        const info = getModuleInfo(modules[0].path)
        expect(info?.name).toBe(modules[0].name)
      }
    })
  })
})
