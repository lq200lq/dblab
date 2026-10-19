/**
 * 通用组件的公共类型。放在独立的 .ts 里：`<script setup>` 不导出类型，
 * 页面要 import 这些形状就只能从模块拿。
 */

export interface TableColumn<Row> {
  /** 取值键；用 slot 自定义渲染时可只当标识用。 */
  key: string
  label: string
  /** 单元格自定义插槽名，默认 `cell-<key>`。 */
  slot?: string
  width?: string
  align?: 'left' | 'right'
  /** 数字、SQL、密钥这类内容用等宽字体。 */
  mono?: boolean
  /** 单元格文本；不给则直接取 row[key]。 */
  formatter?: (row: Row) => string
}

export interface KeyValueItem {
  label: string
  value: string
  mono?: boolean
}

export type FormFieldKind = 'text' | 'password' | 'number' | 'textarea' | 'select' | 'switch' | 'date'

/** 表单字段描述。FormDialog 按它渲染控件，页面只给描述与 zod schema，不写控件布局。 */
export interface FormFieldSpec {
  name: string
  label: string
  kind?: FormFieldKind
  placeholder?: string
  /** 补充说明一律走这里的小字，不塞进段落。 */
  hint?: string
  options?: ReadonlyArray<{ value: string; label: string }>
  required?: boolean
  /** 等宽（主机、库名、前缀这类）。 */
  mono?: boolean
  disabled?: boolean
  /** 两列布局下占满整行。 */
  full?: boolean
}
