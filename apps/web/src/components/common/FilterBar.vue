<script setup lang="ts">
/** 过滤栏的统一排版：一排控件 + 右侧重置。页面只往里塞 FilterSelect / FilterDateRange。 */
</script>

<template>
  <div class="flex flex-wrap items-end gap-3">
    <slot />
    <div class="ml-auto flex items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
