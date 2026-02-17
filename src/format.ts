/**
 * Output formatting: JSON for piped output, human-readable for TTY.
 */

export type Format = 'json' | 'human'

export function detectFormat(explicit?: string): Format {
  if (explicit === 'json' || explicit === 'human') return explicit
  if (process.env.DATACORE_FORMAT === 'json' || process.env.DATACORE_FORMAT === 'human') {
    return process.env.DATACORE_FORMAT
  }
  return process.stdout.isTTY ? 'human' : 'json'
}

export function output(data: unknown, format: Format): void {
  if (format === 'json') {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  if (Array.isArray(data)) {
    printTable(data)
  } else if (typeof data === 'object' && data !== null) {
    printKeyValue(data as Record<string, unknown>)
  } else {
    console.log(data)
  }
}

function printTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log('(no results)')
    return
  }

  const firstRow = rows[0]
  if (!firstRow) return

  const keys = Object.keys(firstRow)
  const widths = keys.map(k =>
    Math.max(k.length, ...rows.map(r => String(r[k] ?? '').length))
  )

  // Header
  console.log(keys.map((k, i) => k.padEnd(widths[i] ?? 0)).join('  '))
  console.log(widths.map(w => '-'.repeat(w)).join('  '))

  // Rows
  for (const row of rows) {
    console.log(keys.map((k, i) => String(row[k] ?? '').padEnd(widths[i] ?? 0)).join('  '))
  }
}

function printKeyValue(obj: Record<string, unknown>): void {
  const keys = Object.keys(obj)
  if (keys.length === 0) return

  const maxKey = Math.max(...keys.map(k => k.length))
  for (const [k, v] of Object.entries(obj)) {
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v)
    console.log(`${k.padEnd(maxKey)}  ${val}`)
  }
}

export function success(message: string): void {
  console.log(`✓ ${message}`)
}

export function info(message: string): void {
  console.log(`  ${message}`)
}

export function warn(message: string): void {
  console.error(`! ${message}`)
}

export function error(message: string): void {
  console.error(`✗ ${message}`)
}
