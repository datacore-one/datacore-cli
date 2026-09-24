import { describe, it, expect } from 'bun:test'
import { initSucceeded } from '../src/lib/python-env'

describe('initSucceeded (review #1)', () => {
  it('is false when any error was recorded, e.g. core Python deps failed', () => {
    expect(initSucceeded({ unresolvable: [], incomplete: [], errors: ['Core Python dependencies are not installed'] })).toBe(false)
  })
  it('is true only when nothing is unresolved, incomplete or errored', () => {
    expect(initSucceeded({ unresolvable: [], incomplete: [], errors: [] })).toBe(true)
    expect(initSucceeded({ unresolvable: ['plur'], incomplete: [], errors: [] })).toBe(false)
  })
})
