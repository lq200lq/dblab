<script setup lang="ts" generic="Row extends { id: number | string }">
/**
 * 受控表格。加载 / 空 / 错三态与分页**只在这里实现一次**，
 * 页面传 rows 即可，不再自己写骨架与「暂无数据」。
 */
import { computed, useSlots } from 'vue'

import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import EmptyState from './EmptyState.vue'
import ErrorState from './ErrorState.vue'
import LoadingSkeleton from './LoadingSkeleton.vue'
import type { TableColumn } from './types'

const props = withDefaults(
  defineProps<{
    columns: TableColumn<Row>[]
    rows: Row[]
    loading?: boolean
    error?: string | null
    emptyTitle?: string
    emptyDescription?: string
    page?: number
    pageSize?: number
    total?: number
    /** 行可点开详情（鼠标悬停高亮 + 手型）。 */
    rowClickable?: boolean
    skeletonRows?: number
  }>(),
  {
    loading: false,
    error: null,
    emptyTitle: '暂无数据',
    emptyDescription: undefined,
    page: 1,
    pageSize: 20,
    total: 0,
    rowClickable: false,
    skeletonRows: 5,
  },
)

const emit = defineEmits<{
  retry: []
  'row-click': [row: Row]
  'update:page': [page: number]
}>()

const slots = useSlots()
const hasRowActions = computed(() => Boolean(slots['row-actions']))
const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
const showPagination = computed(() => !props.loading && !props.error && props.total > props.pageSize)

function cellValue(row: Row, column: TableColumn<Row>): string {
  if (column.formatter) return column.formatter(row)
  const value = (row as Record<string, unknown>)[column.key]
  return value === null || value === undefined || value === '' ? '—' : String(value)
}

function slotNameOf(column: TableColumn<Row>): string {
  return column.slot ?? `cell-${column.key}`
}

function onRowClick(row: Row): void {
  if (props.rowClickable) emit('row-click', row)
}
</script>

<template>
  <div class="card overflow-hidden">
    <LoadingSkeleton v-if="loading" :rows="skeletonRows" />

    <ErrorState v-else-if="error" :message="error" @retry="emit('retry')" />

    <EmptyState v-else-if="rows.length === 0" :title="emptyTitle" :description="emptyDescription">
      <slot name="empty-actions" />
    </EmptyState>

    <div v-else class="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead
              v-for="column in columns"
              :key="column.key"
              :style="{ width: column.width }"
              :class="column.align === 'right' ? 'text-right' : ''"
            >
              {{ column.label }}
            </TableHead>
            <TableHead v-if="hasRowActions" class="w-0 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow
            v-for="row in rows"
            :key="row.id"
            :class="rowClickable ? 'cursor-pointer hover:bg-accent' : ''"
            @click="onRowClick(row)"
          >
            <TableCell
              v-for="column in columns"
              :key="column.key"
              :class="[
                column.align === 'right' ? 'text-right' : '',
                column.mono ? 'mono' : '',
              ]"
            >
              <slot :name="slotNameOf(column)" :row="row" :value="cellValue(row, column)">
                {{ cellValue(row, column) }}
              </slot>
            </TableCell>
            <TableCell v-if="hasRowActions" class="text-right" @click.stop>
              <slot name="row-actions" :row="row" />
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>

    <div
      v-if="showPagination"
      class="flex items-center justify-between border-t border-line px-3 py-2"
    >
      <span class="hint">共 {{ total }} 条</span>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          :disabled="page <= 1"
          @click="emit('update:page', page - 1)"
        >
          上一页
        </Button>
        <span class="hint">{{ page }} / {{ totalPages }}</span>
        <Button
          variant="outline"
          size="sm"
          :disabled="page >= totalPages"
          @click="emit('update:page', page + 1)"
        >
          下一页
        </Button>
      </div>
    </div>
  </div>
</template>
