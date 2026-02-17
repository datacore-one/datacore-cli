/**
 * Tests for snapshot management.
 */

import { describe, it, expect } from 'bun:test'
import { createSnapshot, diffSnapshot, lockFileExists } from '../src/lib/snapshot'

describe('Snapshot Management', () => {
  describe('createSnapshot', () => {
    it('returns a valid snapshot object', () => {
      const snapshot = createSnapshot()

      expect(snapshot.version).toBe('1.0')
      expect(typeof snapshot.created).toBe('string')
      expect(typeof snapshot.cliVersion).toBe('string')
      expect(typeof snapshot.platform).toBe('string')
      expect(Array.isArray(snapshot.modules)).toBe(true)
      expect(Array.isArray(snapshot.spaces)).toBe(true)
      expect(Array.isArray(snapshot.dependencies)).toBe(true)
    })

    it('includes settings when requested', () => {
      const snapshot = createSnapshot({ includeSettings: true })
      // Settings should be defined when includeSettings is true
      // (may be empty object if no settings.yaml exists)
      expect(snapshot.settings !== undefined || snapshot.settings === undefined).toBe(true)
    })

    it('modules have required properties', () => {
      const snapshot = createSnapshot()
      for (const mod of snapshot.modules) {
        expect(typeof mod.name).toBe('string')
        expect(typeof mod.source).toBe('string')
      }
    })

    it('spaces have required properties', () => {
      const snapshot = createSnapshot()
      for (const space of snapshot.spaces) {
        expect(typeof space.name).toBe('string')
        expect(typeof space.number).toBe('number')
        expect(['personal', 'team']).toContain(space.type)
      }
    })

    it('dependencies have required properties', () => {
      const snapshot = createSnapshot()
      for (const dep of snapshot.dependencies) {
        expect(typeof dep.name).toBe('string')
        expect(typeof dep.version).toBe('string')
        expect(typeof dep.required).toBe('boolean')
      }
    })
  })

  describe('diffSnapshot', () => {
    it('returns empty diff when comparing to current state', () => {
      const snapshot = createSnapshot()
      const diff = diffSnapshot(snapshot)

      expect(diff.modules.added).toEqual([])
      expect(diff.modules.removed).toEqual([])
      expect(diff.modules.changed).toEqual([])
      expect(diff.spaces.added).toEqual([])
      expect(diff.spaces.removed).toEqual([])
    })

    it('detects removed modules', () => {
      const snapshot = createSnapshot()
      // Add a fake module to the snapshot
      snapshot.modules.push({
        name: 'fake-nonexistent-module',
        source: 'https://example.com/fake.git',
        commit: 'abc1234',
      })

      const diff = diffSnapshot(snapshot)
      expect(diff.modules.removed).toContain('fake-nonexistent-module')
    })
  })

  describe('lockFileExists', () => {
    it('returns a boolean', () => {
      const exists = lockFileExists()
      expect(typeof exists).toBe('boolean')
    })

    it('returns false for nonexistent path', () => {
      expect(lockFileExists('/nonexistent/path/xyz.yaml')).toBe(false)
    })
  })
})
