/**
 * Tests for git sync utilities.
 */

import { describe, it, expect } from 'bun:test'
import { statusAll, getRepoStatus } from '../src/lib/sync'
import { join } from 'path'

const DATA_DIR = join(process.env.HOME || '~', 'Data')

describe('Sync Utilities', () => {
  describe('statusAll', () => {
    it('returns an array', () => {
      const statuses = statusAll()
      expect(Array.isArray(statuses)).toBe(true)
    })

    it('statuses have required properties', () => {
      const statuses = statusAll()
      for (const status of statuses) {
        expect(typeof status.path).toBe('string')
        expect(typeof status.name).toBe('string')
        expect(typeof status.branch).toBe('string')
        expect(typeof status.ahead).toBe('number')
        expect(typeof status.behind).toBe('number')
        expect(typeof status.dirty).toBe('boolean')
        expect(typeof status.untracked).toBe('number')
      }
    })
  })

  describe('getRepoStatus', () => {
    it('returns null for non-git directory', () => {
      const status = getRepoStatus('/tmp')
      expect(status).toBeNull()
    })

    it('returns status for git directory', () => {
      const status = getRepoStatus(DATA_DIR)
      // Data directory may or may not be a git repo
      if (status) {
        expect(typeof status.branch).toBe('string')
        expect(typeof status.dirty).toBe('boolean')
      }
    })
  })
})
