import { z } from 'zod'

export const loginRequestSchema = z.object({
  username: z.string().min(1, '请输入账号').max(64),
  password: z.string().min(1, '请输入密码').max(200),
})
export type LoginRequest = z.infer<typeof loginRequestSchema>

export const adminUserSchema = z.object({
  id: z.number().int().positive(),
  username: z.string(),
  displayName: z.string().nullable(),
})
export type AdminUser = z.infer<typeof adminUserSchema>

export const sessionResponseSchema = z.object({
  user: adminUserSchema,
})
export type SessionResponse = z.infer<typeof sessionResponseSchema>
