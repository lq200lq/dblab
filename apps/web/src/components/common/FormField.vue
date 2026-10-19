<script setup lang="ts">
/** 表单字段：标签 + 控件 + 错误 + hint。补充信息一律降到 hint 小字，不塞进段落。 */
defineProps<{
  label: string
  error?: string
  hint?: string
  /** 字段名，用于把 label 与控件关联（点击标签聚焦）。 */
  htmlFor?: string
  required?: boolean
}>()
</script>

<template>
  <div class="space-y-1">
    <label class="block text-xs font-medium text-ink" :for="htmlFor">
      {{ label }}
      <span v-if="required" class="text-danger">*</span>
    </label>
    <slot />
    <p v-if="error" class="text-xs text-danger">{{ error }}</p>
    <p v-else-if="hint" class="hint">{{ hint }}</p>
  </div>
</template>
