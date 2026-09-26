/**
 * Tests for git sync utilities.
 *
 * Runs against a fixture installation, not the developer's ~/Data: against the
 * live one, statusAll ran `git status` over every real space and timed out at
 * 5s often enough to block a publish on the publisher's disk state.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { statusAll, getRepoStatus } from '../src/lib/sync'

let root: string
const savedRoot = process.env.DATACORE_ROOT

function gitInit(dir: string) {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@example.com', '-c', 'user.name=T',
    'commit', '-q', '--allow-empty', '-m', 'init'])
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-cli-sync-'))
  gitInit(root)
  gitInit(join(root, '0-personal'))
  process.env.DATACORE_ROOT = root
})

afterAll(() => {
  if (savedRoot === undefined) delete process.env.DATACORE_ROOT
  else process.env.DATACORE_ROOT = savedRoot
  rmSync(root, { recursive: true, force: true })
})

describe('Sync Utilities', () => {
  describe('statusAll', () => {
    it('finds the root repo and each space repo', () => {
      const paths = statusAll().map((s) => s.path).sort()
      expect(paths).toEqual([root, join(root, '0-personal')].sort())
    })

    it('statuses have required properties', () => {
      const statuses = statusAll()
      expect(statuses.length).toBeGreaterThan(0)
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
      const dir = mkdtempSync(join(tmpdir(), 'dc-cli-nogit-'))
      expect(getRepoStatus(dir)).toBeNull()
      rmSync(dir, { recursive: true, force: true })
    })

    it('returns status for git directory', () => {
      const status = getRepoStatus(root)
      expect(status).not.toBeNull()
      expect(status!.branch).toBe('main')
      expect(status!.dirty).toBe(false)
    })
  })
})
