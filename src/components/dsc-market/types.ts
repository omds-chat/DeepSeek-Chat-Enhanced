import type { TranslationKey } from '../../i18n/index.js'
import type { PluginManifest } from '../dsc-plugin-engine/types.js'

/** 索引条目；manifest 为可选的内联完整清单 */
export type MarketEntry = {
  id: string
  name: string
  version: string
  description: string
  author: string
  homepage: string
  download: string
  manifest?: PluginManifest
}

/** 索引顶层结构；schemaVersion 当前只接受 1 */
export type MarketIndex = {
  schemaVersion: number
  plugins: unknown[]
}

/** 索引状态；stale 表示正在使用旧缓存或空列表 */
export type MarketState = 'idle' | 'loading' | 'ready' | 'stale'

/** 当前状态快照 */
export type MarketStatus = {
  state: MarketState
  /** 索引的生成时间；无缓存时为 null */
  fetchedAt: number | null
  total: number
  /** 结构不符被跳过的条目数 */
  skipped: number
  /** 失败原因对应的文案键；成功时为 null */
  error: TranslationKey | null
}
