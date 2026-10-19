import { parseIp } from '@dblab/shared'
import type { FastifyRequest } from 'fastify'

/**
 * 审计里的 client_ip 是 inet 列，塞非法值会整条插入失败、连审计都写不进去。
 * 无法解析就记 null——宁可少一个字段，也不能因此丢一条调用记录。
 *
 * request.ip 是 socket 对端地址；只有在显式打开 TRUST_PROXY 时 Fastify 才会采信
 * x-forwarded-for（见 buildApp 的 trustProxy），否则白名单与审计里的 IP 都会失真。
 */
export function clientIpOf(request: FastifyRequest): string | null {
  const ip = request.ip
  return parseIp(ip) ? ip : null
}
