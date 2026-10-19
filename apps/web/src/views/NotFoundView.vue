<script setup lang="ts">
import { Button } from '@/components/ui/button'
</script>

<template>
  <div class="flex min-h-screen flex-col items-center justify-center gap-3 bg-canvas px-4">
    <p class="text-sm font-semibold text-ink">页面不存在</p>
    <p class="hint">地址可能输错了，或者这个页面已经被移走。</p>
    <RouterLink to="/datasources">
      <Button variant="outline" size="sm">回到数据源</Button>
    </RouterLink>
  </div>
</template>
