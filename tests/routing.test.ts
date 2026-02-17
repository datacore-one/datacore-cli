import { describe, expect, it } from 'bun:test'
import { parseArgs, suggestCommand, RESOURCES, META_COMMANDS } from '../src/routing'

describe('parseArgs', () => {
  describe('help', () => {
    it('returns help for empty args', () => {
      const result = parseArgs([])
      expect(result).toEqual({ type: 'help', topic: undefined, subtopic: undefined })
    })

    it('returns help for --help flag', () => {
      const result = parseArgs(['--help'])
      expect(result).toEqual({ type: 'help', topic: undefined, subtopic: undefined })
    })

    it('returns help for -h flag', () => {
      const result = parseArgs(['-h'])
      expect(result).toEqual({ type: 'help', topic: undefined, subtopic: undefined })
    })

    it('returns help for help command', () => {
      const result = parseArgs(['help'])
      expect(result).toEqual({ type: 'help', topic: undefined, subtopic: undefined })
    })

    it('returns help with topic', () => {
      const result = parseArgs(['help', 'space'])
      expect(result).toEqual({ type: 'help', topic: 'space', subtopic: undefined })
    })

    it('returns help with topic and subtopic', () => {
      const result = parseArgs(['help', 'space', 'create'])
      expect(result).toEqual({ type: 'help', topic: 'space', subtopic: 'create' })
    })

    it('returns help for resource --help', () => {
      const result = parseArgs(['space', '--help'])
      expect(result).toEqual({ type: 'help', topic: 'space', subtopic: undefined })
    })

    it('returns help for resource action --help', () => {
      const result = parseArgs(['space', 'create', '--help'])
      expect(result).toEqual({ type: 'help', topic: 'space', subtopic: 'create' })
    })
  })

  describe('version', () => {
    it('returns meta version for --version', () => {
      const result = parseArgs(['--version'])
      expect(result).toEqual({ type: 'meta', command: 'version', args: [], flags: {} })
    })

    it('returns meta version for -v', () => {
      const result = parseArgs(['-v'])
      expect(result).toEqual({ type: 'meta', command: 'version', args: [], flags: {} })
    })

    it('returns meta version for version command', () => {
      const result = parseArgs(['version'])
      expect(result).toEqual({ type: 'meta', command: 'version', args: [], flags: {} })
    })
  })

  describe('meta commands', () => {
    it('parses init', () => {
      const result = parseArgs(['init'])
      expect(result).toEqual({ type: 'meta', command: 'init', args: [], flags: {} })
    })

    it('parses init with --yes flag', () => {
      const result = parseArgs(['init', '--yes'])
      expect(result).toEqual({ type: 'meta', command: 'init', args: [], flags: { yes: true } })
    })

    it('parses init with --path flag', () => {
      const result = parseArgs(['init', '--path', '~/custom'])
      expect(result).toEqual({ type: 'meta', command: 'init', args: [], flags: { path: '~/custom' } })
    })

    it('parses doctor', () => {
      const result = parseArgs(['doctor'])
      expect(result).toEqual({ type: 'meta', command: 'doctor', args: [], flags: {} })
    })

    it('parses ingest with path', () => {
      const result = parseArgs(['ingest', '~/Documents'])
      expect(result).toEqual({ type: 'meta', command: 'ingest', args: ['~/Documents'], flags: {} })
    })

    it('parses sync', () => {
      const result = parseArgs(['sync'])
      expect(result).toEqual({ type: 'meta', command: 'sync', args: [], flags: {} })
    })

    it('parses sync push', () => {
      const result = parseArgs(['sync', 'push'])
      expect(result).toEqual({ type: 'meta', command: 'sync', args: ['push'], flags: {} })
    })

    it('parses today', () => {
      const result = parseArgs(['today'])
      expect(result).toEqual({ type: 'meta', command: 'today', args: [], flags: {} })
    })

    it('parses tomorrow', () => {
      const result = parseArgs(['tomorrow'])
      expect(result).toEqual({ type: 'meta', command: 'tomorrow', args: [], flags: {} })
    })
  })

  describe('resource commands', () => {
    it('parses space with default action', () => {
      const result = parseArgs(['space'])
      expect(result).toEqual({ type: 'resource', resource: 'space', action: 'list', args: [], flags: {} })
    })

    it('parses space create', () => {
      const result = parseArgs(['space', 'create'])
      expect(result).toEqual({ type: 'resource', resource: 'space', action: 'create', args: [], flags: {} })
    })

    it('parses space create with --name flag', () => {
      const result = parseArgs(['space', 'create', '--name', 'fds'])
      expect(result).toEqual({ type: 'resource', resource: 'space', action: 'create', args: [], flags: { name: 'fds' } })
    })

    it('parses module install with name', () => {
      const result = parseArgs(['module', 'install', 'nightshift'])
      expect(result).toEqual({ type: 'resource', resource: 'module', action: 'install', args: ['nightshift'], flags: {} })
    })

    it('parses config show', () => {
      const result = parseArgs(['config', 'show'])
      expect(result).toEqual({ type: 'resource', resource: 'config', action: 'show', args: [], flags: {} })
    })

    it('parses config set with key and value', () => {
      const result = parseArgs(['config', 'set', 'sync.pull_on_today', 'false'])
      expect(result).toEqual({ type: 'resource', resource: 'config', action: 'set', args: ['sync.pull_on_today', 'false'], flags: {} })
    })

    it('parses nightshift status', () => {
      const result = parseArgs(['nightshift', 'status'])
      expect(result).toEqual({ type: 'resource', resource: 'nightshift', action: 'status', args: [], flags: {} })
    })

    it('parses nightshift queue', () => {
      const result = parseArgs(['nightshift', 'queue', 'Research topic'])
      expect(result).toEqual({ type: 'resource', resource: 'nightshift', action: 'queue', args: ['Research topic'], flags: {} })
    })

    it('parses cron install', () => {
      const result = parseArgs(['cron', 'install'])
      expect(result).toEqual({ type: 'resource', resource: 'cron', action: 'install', args: [], flags: {} })
    })

    it('parses snapshot create', () => {
      const result = parseArgs(['snapshot', 'create'])
      expect(result).toEqual({ type: 'resource', resource: 'snapshot', action: 'create', args: [], flags: {} })
    })
  })

  describe('unknown commands', () => {
    it('returns unknown for unrecognized command', () => {
      const result = parseArgs(['foobar'])
      expect(result).toEqual({ type: 'unknown', command: 'foobar' })
    })
  })

  describe('flag parsing', () => {
    it('parses --flag=value syntax', () => {
      const result = parseArgs(['init', '--path=~/custom'])
      expect(result).toEqual({ type: 'meta', command: 'init', args: [], flags: { path: '~/custom' } })
    })

    it('parses short flags', () => {
      const result = parseArgs(['init', '-y'])
      expect(result).toEqual({ type: 'meta', command: 'init', args: [], flags: { y: true } })
    })

    it('parses --format flag', () => {
      const result = parseArgs(['doctor', '--format', 'json'])
      expect(result).toEqual({ type: 'meta', command: 'doctor', args: [], flags: { format: 'json' } })
    })

    it('parses multiple flags', () => {
      const result = parseArgs(['init', '--path', '~/custom', '--yes', '--format', 'json'])
      expect(result).toEqual({ type: 'meta', command: 'init', args: [], flags: { path: '~/custom', yes: true, format: 'json' } })
    })
  })
})

describe('suggestCommand', () => {
  it('suggests init for ini', () => {
    expect(suggestCommand('ini')).toBe('init')
  })

  it('suggests doctor for docto', () => {
    expect(suggestCommand('docto')).toBe('doctor')
  })

  it('suggests sync for syn', () => {
    expect(suggestCommand('syn')).toBe('sync')
  })

  it('returns null for completely unknown', () => {
    expect(suggestCommand('zzzzzzz')).toBeNull()
  })
})

describe('constants', () => {
  it('RESOURCES contains expected resources', () => {
    expect(RESOURCES).toContain('space')
    expect(RESOURCES).toContain('module')
    expect(RESOURCES).toContain('config')
    expect(RESOURCES).toContain('nightshift')
    expect(RESOURCES).toContain('cron')
    expect(RESOURCES).toContain('snapshot')
  })

  it('META_COMMANDS contains expected commands', () => {
    expect(META_COMMANDS).toContain('init')
    expect(META_COMMANDS).toContain('doctor')
    expect(META_COMMANDS).toContain('ingest')
    expect(META_COMMANDS).toContain('sync')
    expect(META_COMMANDS).toContain('today')
    expect(META_COMMANDS).toContain('tomorrow')
    expect(META_COMMANDS).toContain('version')
  })
})
