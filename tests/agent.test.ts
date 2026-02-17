/**
 * Tests for the agent invoker.
 */

import { describe, it, expect } from 'bun:test'
import { listAgents, agentExists } from '../src/lib/agent'

describe('Agent Utils', () => {
  describe('listAgents', () => {
    it('returns an array', () => {
      const agents = listAgents()
      expect(Array.isArray(agents)).toBe(true)
    })

    it('returns strings', () => {
      const agents = listAgents()
      for (const agent of agents) {
        expect(typeof agent).toBe('string')
      }
    })
  })

  describe('agentExists', () => {
    it('returns false for unknown agent', () => {
      expect(agentExists('nonexistent-agent-xyz')).toBe(false)
    })
  })
})
