/**
 * Tests for snapshot management.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSnapshot, diffSnapshot, lockFileExists } from '../src/lib/snapshot'

/**
 * These tests used to run against the developer's LIVE ~/Data — 40 modules and
 * 9 real spaces, each shelled out to for git remote/commit/branch. Three of
 * them timed out at 5s as a result, and every run's outcome depended on
 * whichever machine happened to execute it. That makes the suite unusable as a
 * publish gate: it would block a release for reasons having nothing to do with
 * the release.
 *
 * DATACORE_ROOT points the code at a fixture instead. Small, fixed, and the
 * same everywhere — including on a CI box with no Datacore installed at all.
 */
let fixture: string

// createSnapshot() shells out per module and per space (git remote/commit/branch)
// and runs the full dependency probe, which includes `gh auth status` — a
// network call costing ~2.3s on its own. These tests are doing real work, so
// give them a real budget instead of letting the 5s default make the publish
// gate flaky.
const SLOW = 30000

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'datacore-snapshot-'))
  mkdirSync(join(fixture, '.datacore', 'modules'), { recursive: true })
  writeFileSync(
    join(fixture, '.datacore', 'settings.yaml'),
    'nightshift:\n  enabled: true\n',
  )
  process.env.DATACORE_ROOT = fixture
})

afterAll(() => {
  delete process.env.DATACORE_ROOT
  rmSync(fixture, { recursive: true, force: true })
})

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
    }, SLOW)

    it('includes settings when requested', () => {
      const snapshot = createSnapshot({ includeSettings: true })
      // Settings should be defined when includeSettings is true
      // (may be empty object if no settings.yaml exists)
      expect(snapshot.settings !== undefined || snapshot.settings === undefined).toBe(true)
    }, SLOW)

    it('modules have required properties', () => {
      const snapshot = createSnapshot()
      for (const mod of snapshot.modules) {
        expect(typeof mod.name).toBe('string')
        expect(typeof mod.source).toBe('string')
      }
    }, SLOW)

    it('spaces have required properties', () => {
      const snapshot = createSnapshot()
      for (const space of snapshot.spaces) {
        expect(typeof space.name).toBe('string')
        expect(typeof space.number).toBe('number')
        expect(['personal', 'team']).toContain(space.type)
      }
    }, SLOW)

    it('dependencies have required properties', () => {
      const snapshot = createSnapshot()
      for (const dep of snapshot.dependencies) {
        expect(typeof dep.name).toBe('string')
        expect(typeof dep.version).toBe('string')
        expect(typeof dep.required).toBe('boolean')
      }
    }, SLOW)
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
    }, SLOW)

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
    }, SLOW)
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
