import type { SessionContext } from '../auth/session.service'

declare module 'fastify' {
  interface FastifyRequest {
    /** 由 requireSession 写入；只有挂了该守卫的路由才保证存在。 */
    adminSession?: SessionContext
  }
}
