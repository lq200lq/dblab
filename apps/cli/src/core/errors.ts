/**
 * 退出码约定，脚本里可据此分支：
 * 0 成功；1 校验失败（地址/密钥/服务不可达）；2 用法错误；3 写入失败。
 */
export const EXIT_OK = 0
export const EXIT_VALIDATE = 1
export const EXIT_USAGE = 2
export const EXIT_WRITE = 3

export type CliErrorKind = 'usage' | 'validate' | 'write'

const EXIT_BY_KIND: Record<CliErrorKind, number> = {
  usage: EXIT_USAGE,
  validate: EXIT_VALIDATE,
  write: EXIT_WRITE,
}

export class CliError extends Error {
  readonly kind: CliErrorKind
  readonly exitCode: number
  /** 给人看的补充说明，可为空。 */
  readonly hint?: string

  constructor(kind: CliErrorKind, message: string, hint?: string) {
    super(message)
    this.name = 'CliError'
    this.kind = kind
    this.exitCode = EXIT_BY_KIND[kind]
    if (hint !== undefined) this.hint = hint
  }
}

/** 配置文件读不懂时的统一错误，写盘动作必须在此之前中止。 */
export class MalformedConfigError extends CliError {
  readonly path: string

  constructor(path: string, reason: string) {
    super('write', `配置文件无法解析：${path}`, `${reason}；请先手工修好这份文件，本次不做任何写入。`)
    this.name = 'MalformedConfigError'
    this.path = path
  }
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError
}
