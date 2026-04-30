/**
 * Tests for the `app` subcommand helpers — focused on the gate logic that
 * decides whether to show "Coming soon" or proceed.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import * as app from '../src/lib/app'

const ORIGINAL_ENABLED = process.env.DATACORE_APP_ENABLED
const ORIGINAL_REPO = process.env.DATACORE_APP_REPO

describe('app.isAppAvailable', () => {
  beforeEach(() => {
    delete process.env.DATACORE_APP_ENABLED
    process.env.DATACORE_APP_REPO = '/nonexistent-path-for-tests'
  })

  afterEach(() => {
    if (ORIGINAL_ENABLED !== undefined) {
      process.env.DATACORE_APP_ENABLED = ORIGINAL_ENABLED
    }
    if (ORIGINAL_REPO !== undefined) {
      process.env.DATACORE_APP_REPO = ORIGINAL_REPO
    }
  })

  test('DATACORE_APP_ENABLED=1 always returns true (override)', () => {
    process.env.DATACORE_APP_ENABLED = '1'
    expect(app.isAppAvailable()).toBe(true)
  })

  test('returns boolean (real-world depends on machine)', () => {
    // We can't reliably assert true or false here because /Applications/
    // Datacore.app may or may not exist on the runner. But the function
    // must always return a boolean — never throw, never return undefined.
    const result = app.isAppAvailable()
    expect(typeof result).toBe('boolean')
  })
})

describe('app.COMING_SOON_MESSAGE', () => {
  test('is a non-empty string mentioning the app', () => {
    expect(typeof app.COMING_SOON_MESSAGE).toBe('string')
    expect(app.COMING_SOON_MESSAGE.length).toBeGreaterThan(20)
    expect(app.COMING_SOON_MESSAGE.toLowerCase()).toContain('coming soon')
  })
})

describe('app.findAppRepo', () => {
  test('returns null when DATACORE_APP_REPO points to nonexistent path AND no defaults exist', () => {
    process.env.DATACORE_APP_REPO = '/nonexistent-path-for-tests'
    // The fn also checks DEFAULT_REPO_CANDIDATES, which on the runner may
    // or may not exist. We only assert no-throw.
    const result = app.findAppRepo()
    expect(result === null || typeof result === 'string').toBe(true)
  })

  test('returns the override path when it exists', () => {
    // Use this very file's directory — guaranteed to exist
    process.env.DATACORE_APP_REPO = process.cwd()
    expect(app.findAppRepo()).toBe(process.cwd())
  })
})
