<script setup lang="ts">
/**
 * 过滤下拉：吃「选项数组」，空值表示不过滤。
 * 选项的 label 一律由页面从 shared 的标签表里取，组件里没有中文字面量。
 */
withDefaults(
  defineProps<{
    label: string
    options: ReadonlyArray<{ value: string; label: string }>
    placeholder?: string
    width?: string
  }>(),
  { placeholder: '全部', width: '9rem' },
)

const model = defineModel<string | undefined>({ default: undefined })
</script>

<template>
  <label class="flex flex-col gap-1">
    <span class="text-xs text-muted-foreground">{{ label }}</span>
    <select v-model="model" class="input" :style="{ width }">
      <option :value="undefined">{{ placeholder }}</option>
      <option v-for="option in options" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>
  </label>
</template>
