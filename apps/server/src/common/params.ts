import type { FastifyRequest } from 'fastify'

import { AppError } from './errors'

/** 路径参数里的主键。非数字直接按 400 拒掉，不要让它走到查询里。 */
export function idParam(request: FastifyRequest): number {
  const raw = (request.params as Record<string, string | undefined>).id
  const value = Number(raw)
  if (!raw || !Number.isInteger(value) || value <= 0) {
    throw new AppError('VALIDATION_FAILED', '路径里的 id 不合法')
  }
  return value
}
