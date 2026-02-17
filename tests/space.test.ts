/**
 * Tests for space management.
 */

import { describe, it, expect } from 'bun:test'
import { listSpaces, getSpace, auditSpace } from '../src/lib/space'

describe('Space Management', () => {
  describe('listSpaces', () => {
    it('returns an array', () => {
      const spaces = listSpaces()
      expect(Array.isArray(spaces)).toBe(true)
    })

    it('spaces have required properties', () => {
      const spaces = listSpaces()
      for (const space of spaces) {
        expect(typeof space.name).toBe('string')
        expect(typeof space.number).toBe('number')
        expect(typeof space.path).toBe('string')
        expect(['personal', 'team']).toContain(space.type)
        expect(typeof space.hasGit).toBe('boolean')
        expect(typeof space.hasClaude).toBe('boolean')
      }
    })

    it('spaces are sorted by number', () => {
      const spaces = listSpaces()
      for (let i = 1; i < spaces.length; i++) {
        const prev = spaces[i - 1]
        const curr = spaces[i]
        if (prev && curr) {
          expect(prev.number).toBeLessThanOrEqual(curr.number)
        }
      }
    })
  })

  describe('getSpace', () => {
    it('returns null for non-existent space', () => {
      expect(getSpace('nonexistent-space-xyz')).toBeNull()
      expect(getSpace(999)).toBeNull()
    })

    it('finds space by number', () => {
      const spaces = listSpaces()
      if (spaces.length > 0 && spaces[0]) {
        const found = getSpace(spaces[0].number)
        expect(found).not.toBeNull()
        expect(found?.name).toBe(spaces[0].name)
      }
    })

    it('finds space by name', () => {
      const spaces = listSpaces()
      if (spaces.length > 0 && spaces[0]) {
        const found = getSpace(spaces[0].name)
        expect(found).not.toBeNull()
        expect(found?.number).toBe(spaces[0].number)
      }
    })
  })

  describe('auditSpace', () => {
    it('audits existing space', () => {
      const spaces = listSpaces()
      if (spaces.length > 0 && spaces[0]) {
        const result = auditSpace(spaces[0].name)
        expect(result.space).toBe(spaces[0].name)
        expect(result.path).toBe(spaces[0].path)
        expect(Array.isArray(result.issues)).toBe(true)
        expect(['healthy', 'warnings', 'errors']).toContain(result.status)
      }
    })

    it('throws for non-existent space', () => {
      expect(() => auditSpace('nonexistent-space-xyz')).toThrow()
    })
  })
})
