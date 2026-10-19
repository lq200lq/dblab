import type { FastifyRequest } from 'fastify'

import { AppError } from './errors'

export interface Actor {
  id: number
  username: string
}

/** 取当前管理员。路由挂了 requireSession 才会有值；没有就是编程错误，按 401 抛。 */
export function actorOf(request: FastifyRequest): Actor {
  const session = request.adminSession
  if (!session) throw new AppError('UNAUTHORIZED')
  return { id: session.user.id, username: session.user.username }
}
