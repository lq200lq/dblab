import type { FastifyReply, FastifyRequest } from 'fastify'

import { AppError } from '../common/errors'

import type { SessionService } from './session.service'

/** 管理面路由的前置守卫：没有有效会话一律 401，路由里就不用各写一遍。 */
export function requireSession(sessions: SessionService, cookieName: string) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const context = await sessions.resolve(request.cookies[cookieName])
    if (!context) throw new AppError('UNAUTHORIZED')
    request.adminSession = context
  }
}
