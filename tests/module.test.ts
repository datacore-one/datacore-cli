/**
 * Tests for module management.
 */

import { describe, it, expect } from 'bun:test'
import { listModules, getModuleInfo } from '../src/lib/module'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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
      // This asserted `.not.toBeNull()`, against its own name, with the comment
      // "It returns partial info even for missing paths" -- it documented the
      // bug rather than the intent. The consequence was live: every directory
      // under .datacore/modules/ counted as a module, so the manifest-less
      // `state/` directory was reported as installed by `module list`, by the
      // install summary, and to the assistant on first run.
      expect(getModuleInfo('/nonexistent/path/xyz')).toBeNull()
    })

    it('returns null for a directory with no manifest', () => {
      expect(getModuleInfo(mkdtempSync(join(tmpdir(), 'not-a-module-')))).toBeNull()
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
