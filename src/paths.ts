import { join, resolve } from 'path'

function expandHome(path: string): string {
  const home = process.env.HOME
  if (!home) return path
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

const configuredDataDir = process.env.DATACORE_PATH?.trim()

export const DATA_DIR = configuredDataDir
  ? resolve(expandHome(configuredDataDir))
  : join(process.env.HOME || '~', 'Data')

export const DISPLAY_DATA_DIR = configuredDataDir || '~/Data'
export const DATACORE_DIR = join(DATA_DIR, '.datacore')

export function displayPath(path: string): string {
  return path.startsWith(DATA_DIR) ? path.replace(DATA_DIR, DISPLAY_DATA_DIR) : path
}
