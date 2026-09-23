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
 * Reveal a block of text a line at a time.
 *
 * Nothing is recomputed and nothing is faked -- the text is already final, this
 * only controls when each line appears.
 */
export async function revealBox(text: string, perLine = 45): Promise<void> {
  for (const line of text.split('\n')) {
    console.log(line)
    await sleep(perLine)
  }
}

/**
 * Report, one line at a time, things that are already true.
 *
 * This replaces a version that printed "Initializing neural pathways... OK"
 * and four more like it, on a fixed timer, regardless of what had happened.
 * In an installer whose central bug was reporting success while half-built,
 * five invented OK lines at the finish are not decoration -- they are the same
 * defect wearing a costume. So the caller passes facts it has measured, and
 * the animation is only the timing of their arrival.
 */
export async function bootSequence(
  lines: { label: string; value?: string; ok?: boolean }[],
  perLine = 110,
): Promise<void> {
  for (const line of lines) {
    process.stdout.write(`${c.dim}> ${line.label}${c.reset}`)
    await sleep(perLine)
    const mark = line.ok === false ? `${c.yellow}--${c.reset}` : `${c.green}OK${c.reset}`
    process.stdout.write(` ${line.value ? `${c.reset}${line.value} ` : ''}${mark}\n`)
    await sleep(perLine / 3)
  }
}

/**
 * The finish: a beat of rain, the box, then what was actually built.
 *
 * Skipped whenever output is not a live terminal, and by DATACORE_NO_ANIMATION
 * or CI. It runs once at the end of an install that a person is watching; the
 * same install driven by an agent or a script prints the same facts instantly.
 */
export async function completionSequence(
  facts: { label: string; value?: string; ok?: boolean }[],
  opts: { enabled?: boolean } = {},
): Promise<void> {
  const enabled = opts.enabled ?? (
    !!process.stdout.isTTY
    && !process.env.DATACORE_NO_ANIMATION
    && !process.env.CI
  )

  if (!enabled) {
    console.log(INIT_COMPLETE)
    for (const f of facts) console.log(`  ${f.ok === false ? '--' : 'OK'} ${f.label}${f.value ? ` ${f.value}` : ''}`)
    return
  }

  await matrixRain(420)
  await revealBox(INIT_COMPLETE, 40)
  console.log()
  await bootSequence(facts)
}
