import {
  ERROR_CODES,
  ERROR_MESSAGE_BY_CODE,
  HTTP_STATUS_BY_CODE,
  type ApiErrorBody,
  type ErrorCode,
} from '@dblab/shared'
import { ZodError } from 'zod'

/** 带错误码的业务异常。HTTP 状态与中文兜底文案都从 shared 的错误码表里取。 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details?: unknown

  constructor(code: ErrorCode, message?: string, options?: { details?: unknown; cause?: unknown }) {
    super(message ?? ERROR_MESSAGE_BY_CODE[code], options?.cause ? { cause: options.cause } : undefined)
    this.name = 'AppError'
    this.code = code
    this.status = HTTP_STATUS_BY_CODE[code]
    this.details = options?.details
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
}

export function toErrorBody(err: unknown): { status: number; body: ApiErrorBody } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    }
  }

  // 字段校验失败：把第一条字段级文案直接当 message，前端不必再翻译。
  if (err instanceof ZodError) {
    const first = err.issues[0]
    return {
      status: HTTP_STATUS_BY_CODE.VALIDATION_FAILED,
      body: {
        code: 'VALIDATION_FAILED',
        message: first?.message ?? ERROR_MESSAGE_BY_CODE.VALIDATION_FAILED,
        details: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    }
  }

  // 数据层抛出的带码异常（主密钥不可用、口令解不开等）。
  // 注意：这里用 shared 的中文兜底文案，**不透出内部 message**——内部文案里带文件路径等信息。
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code
    if (isErrorCode(code)) {
      return {
        status: HTTP_STATUS_BY_CODE[code],
        body: { code, message: ERROR_MESSAGE_BY_CODE[code] },
      }
    }

    // Fastify 自己的 4xx（请求体不是合法 JSON、超出体积上限等）。
    // 落到这里不处理的话会被当成 500，把客户端的错记成服务端的错。
    const statusCode = (err as { statusCode?: unknown }).statusCode
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      const code: ErrorCode = statusCode === 404 ? 'NOT_FOUND' : 'VALIDATION_FAILED'
      return { status: statusCode, body: { code, message: ERROR_MESSAGE_BY_CODE[code] } }
    }
  }

  return {
    status: 500,
    body: { code: 'INTERNAL', message: ERROR_MESSAGE_BY_CODE.INTERNAL },
  }
}
