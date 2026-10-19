<script setup lang="ts">
/**
 * IP 白名单编辑器：标签列表 + 输入 + 预校验（复用 shared 的 CIDR 解析器）。
 * 校验放在这里而不是等提交后由服务端打回——格式错的网段能立刻看出来。
 */
import { computed, ref } from 'vue'

import { isValidCidrInput } from '@dblab/shared'

import { Button } from '@/components/ui/button'

const model = defineModel<string[]>({ default: () => [] })

const draft = ref('')
const error = ref<string | null>(null)

const atLimit = computed(() => model.value.length >= 64)

function add(): void {
  const value = draft.value.trim()
  if (!value) return
  if (!isValidCidrInput(value)) {
    // 形态提示写清两种写法：只写 IP 与写网段是两回事。
    error.value = '格式不正确，例如 10.0.0.0/8 或 127.0.0.1'
    return
  }
  if (model.value.includes(value)) {
    error.value = '这一条已经在白名单里了'
    return
  }
  if (atLimit.value) {
    error.value = '白名单最多 64 条'
    return
  }
  model.value = [...model.value, value]
  draft.value = ''
  error.value = null
}

function remove(value: string): void {
  model.value = model.value.filter((entry) => entry !== value)
  error.value = null
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex gap-2">
      <input
        v-model="draft"
        class="input mono min-w-0 flex-1"
        placeholder="10.0.0.0/8"
        autocomplete="off"
        @keydown.enter.prevent="add"
      />
      <Button variant="outline" size="sm" type="button" :disabled="atLimit" @click="add">添加</Button>
    </div>

    <p v-if="error" class="text-xs text-danger">{{ error }}</p>
    <p v-else class="hint">留空表示不限制来源；填了就只允许这些地址调用</p>

    <div v-if="model.length > 0" class="flex flex-wrap gap-1.5">
      <span v-for="entry in model" :key="entry" class="chip">
        {{ entry }}
        <button
          type="button"
          class="text-muted-foreground transition-colors hover:text-danger"
          :aria-label="`移除 ${entry}`"
          @click="remove(entry)"
        >
          ×
        </button>
      </span>
    </div>
  </div>
</template>
