/**
 * Terminal animations for that hacker aesthetic.
 */

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const MATRIX_CHARS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789'

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
}

export const BANNER = `
${c.cyan}${c.bright}
    ██████╗  █████╗ ████████╗ █████╗  ██████╗ ██████╗ ██████╗ ███████╗
    ██╔══██╗██╔══██╗╚══██╔══╝██╔══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝
    ██║  ██║███████║   ██║   ███████║██║     ██║   ██║██████╔╝█████╗
    ██║  ██║██╔══██║   ██║   ██╔══██║██║     ██║   ██║██╔══██╗██╔══╝
    ██████╔╝██║  ██║   ██║   ██║  ██║╚██████╗╚██████╔╝██║  ██║███████╗
    ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝
${c.reset}${c.dim}                    AI-Powered Second Brain ${c.reset}
`

export const INIT_COMPLETE = `
${c.green}${c.bright}
    ╔══════════════════════════════════════════════════════════╗
    ║                                                          ║
    ║   ${c.reset}${c.green}██  D A T A C O R E   S Y S T E M   O N L I N E  ██${c.bright}   ║
    ║   ${c.reset}${c.dim}       ▸ All systems nominal. Ready to engage. ◂${c.green}${c.bright}      ║
    ║                                                          ║
    ╚══════════════════════════════════════════════════════════╝
${c.reset}
`

/**
 * Sleep for ms milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Type out text character by character.
 */
export async function typewrite(text: string, speed = 30): Promise<void> {
  for (const char of text) {
    process.stdout.write(char)
    await sleep(speed)
  }
  console.log()
}

/**
 * Print with a brief matrix-style scramble effect.
 */
export async function glitchText(text: string, iterations = 3): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    const scrambled = text.split('').map(char => {
      if (char === ' ') return ' '
      return Math.random() > 0.5 ? MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)] : char
    }).join('')
    process.stdout.write(`\r${c.green}${scrambled}${c.reset}`)
    await sleep(50)
  }
  process.stdout.write(`\r${text}${' '.repeat(10)}\n`)
}

/**
 * Animated spinner with message.
 */
export class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null
  private frame = 0
  private message: string

  constructor(message: string) {
    this.message = message
  }

  start(): void {
    process.stdout.write('\x1b[?25l') // Hide cursor
    this.interval = setInterval(() => {
      const spinner = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]
      process.stdout.write(`\r${c.cyan}${spinner}${c.reset} ${this.message}`)
      this.frame++
    }, 80)
  }

  update(message: string): void {
    this.message = message
  }

  succeed(message?: string): void {
    this.stop()
    console.log(`\r${c.green}✓${c.reset} ${message || this.message}`)
  }

  fail(message?: string): void {
    this.stop()
    console.log(`\r${c.yellow}✗${c.reset} ${message || this.message}`)
  }

  private stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    process.stdout.write('\x1b[?25h') // Show cursor
    process.stdout.write('\r' + ' '.repeat(this.message.length + 10) + '\r')
  }
}

/**
 * Progress bar.
 */
export function progressBar(current: number, total: number, width = 30): string {
  const percent = current / total
  const filled = Math.round(width * percent)
  const empty = width - filled
  const bar = `${c.green}${'█'.repeat(filled)}${c.dim}${'░'.repeat(empty)}${c.reset}`
  return `[${bar}] ${Math.round(percent * 100)}%`
}

/**
 * Print a step with number.
 */
export function step(num: number, total: number, message: string): void {
  console.log(`${c.dim}[${num}/${total}]${c.reset} ${message}`)
}

/**
 * Print section header.
 */
export function section(title: string): void {
  console.log()
  console.log(`${c.cyan}${c.bright}▸ ${title}${c.reset}`)
  console.log(`${c.dim}${'─'.repeat(50)}${c.reset}`)
}

/**
 * Matrix rain effect (brief).
 */
export async function matrixRain(duration = 500): Promise<void> {
  const cols = process.stdout.columns || 80
  const rows = 3
  const drops: number[] = Array(cols).fill(0).map(() => Math.floor(Math.random() * rows))

  const startTime = Date.now()
  while (Date.now() - startTime < duration) {
    let frame = ''
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const drop = drops[x] ?? 0
        if (drop === y) {
          frame += `${c.green}${c.bright}${MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)]}${c.reset}`
        } else if (drop === y - 1) {
          frame += `${c.green}${MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)]}${c.reset}`
        } else {
          frame += ' '
        }
      }
      frame += '\n'
    }
    process.stdout.write(frame)

    // Move drops down
    for (let i = 0; i < drops.length; i++) {
      if (Math.random() > 0.9) drops[i] = 0
      else drops[i] = (drops[i] ?? 0) + 1
    }

    await sleep(50)
    process.stdout.write(`\x1b[${rows}A`) // Move cursor up
  }

  // Clear
  for (let y = 0; y < rows; y++) {
    console.log(' '.repeat(cols))
  }
  process.stdout.write(`\x1b[${rows}A`)
}

/**
 * Boot sequence effect.
 */
export async function bootSequence(): Promise<void> {
  const lines = [
    'Initializing neural pathways...',
    'Loading cognitive frameworks...',
    'Establishing knowledge graph...',
    'Calibrating AI agents...',
    'Synchronizing memory banks...',
  ]

  for (const line of lines) {
    process.stdout.write(`${c.dim}> ${line}${c.reset}`)
    await sleep(100 + Math.random() * 200)
    process.stdout.write(` ${c.green}OK${c.reset}\n`)
    await sleep(50)
  }
}
