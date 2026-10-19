/** 领域组件的公共形状。`<script setup>` 不导出类型，页面要从模块里 import。 */

/** 一条授权：数据源 × 读/写。两个开关都关的行会被丢弃，服务端契约也不接受。 */
export interface GrantRow {
  datasourceId: number
  canRead: boolean
  canWrite: boolean
}
