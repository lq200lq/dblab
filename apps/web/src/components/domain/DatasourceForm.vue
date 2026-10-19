<script setup lang="ts">
/**
 * 数据源的新建/编辑表单。两种模式的差别只有两点：
 * 新建必须给口令；编辑时口令留空表示「不改」。
 *
 * 表单自己有一套 schema（含 ssl/sslVerify/enabled 这些开关），
 * 提交时才映射成 @dblab/shared 的线上契约——**表单形状不等于请求形状**：
 * 直接拿线上 schema 校验会把不在契约里的开关字段剥掉，ssl 就会被静默改成 false。
 */
import { computed, ref, watch } from 'vue'
import { z } from 'zod'

import type { Datasource, DatasourceCreate, DatasourceTestResult, DatasourceUpdate } from '@dblab/shared'
import {
  ENGINE_LABEL,
  ENGINE_VALUES,
  datasourceCreateSchema,
  datasourceProbeSchema,
  datasourceUpdateSchema,
  engineSchema,
  isErrorCode,
} from '@dblab/shared'

import { probeDatasource } from '@/api'
import { errorCodeOf, errorMessage } from '@/api/http'
import FormDialog from '@/components/common/FormDialog.vue'
import type { FormFieldSpec } from '@/components/common/types'
import TestResultPanel from './TestResultPanel.vue'

const props = defineProps<{
  mode: 'create' | 'update'
  datasource?: Datasource
  pending?: boolean
}>()

const emit = defineEmits<{
  create: [input: DatasourceCreate]
  update: [input: DatasourceUpdate]
}>()

const open = defineModel<boolean>('open', { default: false })

const ENGINE_OPTIONS = ENGINE_VALUES.map((value) => ({ value, label: ENGINE_LABEL[value] }))

const formSchema = z.object({
  name: z.string().min(1, '请填写名称').max(64),
  engine: engineSchema,
  host: z.string().min(1, '请填写主机').max(255),
  port: z.coerce.number().int().min(1, '请填写端口').max(65535),
  database: z.string().min(1, '请填写库名').max(128),
  username: z.string().min(1, '请填写账号').max(128),
  password:
    props.mode === 'create'
      ? z.string().min(1, '请填写口令').max(512)
      : z.string().max(512).optional(),
  ssl: z.boolean(),
  sslVerify: z.boolean(),
  enabled: z.boolean(),
})

const fields = computed<FormFieldSpec[]>(() => [
  { name: 'name', label: '名称', placeholder: '例如 order-db-prod', required: true },
  {
    name: 'engine',
    label: '引擎',
    kind: 'select',
    options: ENGINE_OPTIONS,
    disabled: props.mode === 'update',
    hint: props.mode === 'update' ? '引擎不可修改' : undefined,
  },
  { name: 'host', label: '主机', placeholder: '127.0.0.1', mono: true, required: true },
  { name: 'port', label: '端口', kind: 'number', placeholder: '5432', required: true },
  { name: 'database', label: '库名', mono: true, required: true },
  { name: 'username', label: '账号', mono: true, required: true },
  {
    name: 'password',
    label: '口令',
    kind: 'password',
    required: props.mode === 'create',
    hint: props.mode === 'update' ? '留空表示不修改；测试连接会沿用已存的那份' : '写入即加密存储，之后不再回显',
  },
  { name: 'ssl', label: '启用 SSL', kind: 'switch', hint: '仅在数据源要求 TLS 时打开' },
  { name: 'sslVerify', label: '校验证书', kind: 'switch', hint: '内网自签证书才需要关掉' },
  { name: 'enabled', label: '启用', kind: 'switch', hint: '停用后 Agent 无法再访问该库' },
])

const initial = computed<Record<string, unknown>>(() => ({
  name: props.datasource?.name ?? '',
  engine: props.datasource?.engine ?? 'postgres',
  host: props.datasource?.host ?? '127.0.0.1',
  port: props.datasource?.port ?? 5432,
  database: props.datasource?.database ?? '',
  username: props.datasource?.username ?? '',
  password: '',
  ssl: props.datasource?.connectOptions.ssl ?? false,
  // 缺省即校验：只有显式关掉才不校验。
  sslVerify: props.datasource?.connectOptions.sslVerify !== false,
  enabled: props.datasource?.enabled ?? true,
}))

const testing = ref(false)
const testResult = ref<DatasourceTestResult | null>(null)

// 每次打开都当作没测过：弹窗里留着上一次的结论会误导当前这份配置。
watch(open, (value) => {
  if (value) testResult.value = null
})

/** 表单里的两个 TLS 开关 → 线上契约的 connectOptions 部分。 */
function sslOptionsOf(values: Record<string, unknown>) {
  return {
    ssl: values.ssl === true,
    ...(values.ssl === true ? { sslVerify: values.sslVerify !== false } : {}),
  }
}

function connectOptionsOf(existing: Datasource | undefined) {
  const options = { ...(existing?.connectOptions ?? {}) }
  // 不开 TLS 时「是否校验证书」没有意义，不要把一个用不到的开关留在配置里。
  if (options.sslVerify !== undefined && options.ssl !== true) delete options.sslVerify
  return options
}

async function onTest(values: Record<string, unknown>): Promise<void> {
  testing.value = true
  testResult.value = null
  const password = typeof values.password === 'string' ? values.password : ''
  try {
    testResult.value = await probeDatasource(
      datasourceProbeSchema.parse({
        name: values.name,
        engine: values.engine,
        host: values.host,
        port: values.port,
        database: values.database,
        username: values.username,
        // 留空就不带这个字段，让服务端沿用已存的那份口令。
        ...(password ? { password } : {}),
        // 新建模式没有 id，此时口令是必填项。
        ...(props.mode === 'update' && props.datasource ? { datasourceId: props.datasource.id } : {}),
        connectOptions: sslOptionsOf(values),
      }),
    )
  } catch (error) {
    // 平台侧的失败（校验没过、主密钥不可用）也当成一次探测结果就地显示，
    // 否则点完按钮什么都不出现，用户会以为没生效。
    const code = errorCodeOf(error)
    testResult.value = {
      ok: false,
      latencyMs: 0,
      serverVersion: null,
      errorCode: isErrorCode(code) ? code : null,
      message: errorMessage(error),
    }
  } finally {
    testing.value = false
  }
}

function onSubmit(values: Record<string, unknown>): void {
  testResult.value = null
  const connectOptions = { ...connectOptionsOf(props.datasource), ...sslOptionsOf(values) }

  if (props.mode === 'create') {
    emit('create', datasourceCreateSchema.parse({ ...values, connectOptions }))
    return
  }

  // 口令留空 = 不带这个字段，服务端据此保留原密文（逐字节不变）。
  const { password, ...rest } = values
  emit(
    'update',
    datasourceUpdateSchema.parse({
      ...rest,
      ...(typeof password === 'string' && password.length > 0 ? { password } : {}),
      connectOptions,
    }),
  )
}
</script>

<template>
  <FormDialog
    v-model:open="open"
    :title="mode === 'create' ? '新建数据源' : '编辑数据源'"
    :description="mode === 'create' ? '接入后即可签发密钥并授权访问' : undefined"
    :schema="formSchema"
    :fields="fields"
    :initial="initial"
    :pending="pending"
    secondary-label="测试连接"
    :secondary-pending="testing"
    submit-label="保存"
    @submit="onSubmit"
    @secondary="onTest"
    @change="testResult = null"
  >
    <template #extra>
      <div v-if="testResult" class="mt-4">
        <TestResultPanel :result="testResult" />
      </div>
    </template>
  </FormDialog>
</template>
