<script setup lang="ts">
/** 登录页。单管理员，所以只有账号 + 口令两个字段。 */
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { z } from 'zod'

import { ApiError, errorMessage } from '@/api/http'
import FormField from '@/components/common/FormField.vue'
import { Button } from '@/components/ui/button'
import { useForm } from '@/composables/useForm'
import { signIn, useAuth } from '@/stores/auth'

const route = useRoute()
const router = useRouter()
const { pending } = useAuth()

const form = useForm(
  z.object({
    username: z.string().min(1, '请填写账号'),
    password: z.string().min(1, '请填写口令'),
  }),
  { username: 'admin', password: '' },
)

// 登录失败的原因就地显示（口令错、服务端没起），不用 toast 遮住表单。
const submitError = ref<string | null>(null)

async function onSubmit(): Promise<void> {
  submitError.value = null
  await form.submit(async (parsed) => {
    try {
      await signIn(parsed.username, parsed.password)
      const target = typeof route.query.redirect === 'string' ? route.query.redirect : '/datasources'
      await router.replace(target)
    } catch (error) {
      submitError.value = error instanceof ApiError ? error.message : errorMessage(error)
    }
  })
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-canvas px-4">
    <form class="card w-full max-w-sm space-y-4 p-6" @submit.prevent="onSubmit">
      <div class="space-y-1">
        <h1 class="text-base font-semibold text-ink">登录 DbLab</h1>
        <p class="hint">平台管控台，仅管理员可进入</p>
      </div>

      <FormField label="账号" :error="form.errorOf('username')" html-for="login-username" required>
        <input
          id="login-username"
          class="input"
          autocomplete="username"
          :value="String(form.values.username ?? '')"
          @input="form.values.username = ($event.target as HTMLInputElement).value"
        />
      </FormField>

      <FormField label="口令" :error="form.errorOf('password')" html-for="login-password" required>
        <input
          id="login-password"
          class="input"
          type="password"
          autocomplete="current-password"
          :value="String(form.values.password ?? '')"
          @input="form.values.password = ($event.target as HTMLInputElement).value"
        />
      </FormField>

      <p v-if="submitError" class="text-xs text-danger">{{ submitError }}</p>

      <Button type="submit" class="w-full" :disabled="pending">
        {{ pending ? '登录中…' : '登录' }}
      </Button>
    </form>
  </div>
</template>
