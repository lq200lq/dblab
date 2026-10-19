/**
 * 输出层。所有对外文案（含密钥）都从这里出去，颜色只在 TTY 下生效，
 * 便于重定向到文件时拿到干净文本。
 */
export interface Output {
  info(message: string): void
  success(message: string): void
  warn(message: string): void
  error(message: string): void
  plain(message: string): void
}

const CODES = {
  reset: '\u001b[0m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
} as const

export interface CreateOutputOptions {
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  color?: boolean
}

export function createOutput(options: CreateOutputOptions = {}): Output {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const color = options.color ?? Boolean((stdout as { isTTY?: boolean }).isTTY)

  const paint = (code: keyof typeof CODES, text: string): string =>
    color ? `${CODES[code]}${text}${CODES.reset}` : text

  const writeln = (stream: NodeJS.WritableStream, text: string): void => {
    stream.write(`${text}\n`)
  }

  return {
    info: (message) => writeln(stdout, paint('cyan', message)),
    success: (message) => writeln(stdout, paint('green', message)),
    warn: (message) => writeln(stderr, paint('yellow', message)),
    error: (message) => writeln(stderr, paint('red', message)),
    plain: (message) => writeln(stdout, message),
  }
}

/** 中日韩字符占两列，纯 `length` 对不齐表格，这里按显示宽度算。 */
export function visualWidth(text: string): number {
  let width = 0
  for (const char of text) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(
      char,
    )
      ? 2
      : 1
  }
  return width
}

export function padEndVisual(text: string, width: number): string {
  const padding = width - visualWidth(text)
  return padding > 0 ? `${text}${' '.repeat(padding)}` : text
}

