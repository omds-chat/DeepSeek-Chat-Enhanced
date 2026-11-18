import { APP_NAME } from '../../brand.js'
import { readManifest } from './registry.js'
import type { PluginManifest, PluginSource } from './types.js'

/** 旧版安装记录的 localStorage 键；迁移到 IndexedDB 后只用于读取与清理 */
const STORAGE_KEY = `${APP_NAME}:plugins`

/** 一条旧版安装记录 */
export type LegacyPlugin = {
  manifest: PluginManifest
  source: PluginSource
  enabled: boolean
}

/** 旧版记录的读取结果 */
export type LegacyReadResult = {
  entries: LegacyPlugin[]
  /** localStorage 中是否存在旧键；用于判断是否需要迁移 */
  present: boolean
  /** 读取或解析过程中丢弃的内容 */
  problem: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readSource = (value: unknown): PluginSource | null => {
  if (!isRecord(value)) {
    return null
  }
  if (value.kind === 'builtin') {
    return { kind: 'builtin' }
  }
  if (value.kind === 'url' && typeof value.url === 'string' && value.url !== '') {
    return { kind: 'url', url: value.url }
  }
  return null
}

const readEntry = (value: unknown): LegacyPlugin | null => {
  if (!isRecord(value)) {
    return null
  }
  const manifest = readManifest(value.manifest)
  const source = readSource(value.source)
  if (!manifest || !source) {
    return null
  }
  return { manifest, source, enabled: value.enabled === true }
}

/** 读取旧版记录；单条损坏只丢弃该条，不整体失败 */
export const readLegacyInstalled = (): LegacyReadResult => {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return { entries: [], present: false, problem: 'localStorage is not available' }
  }
  if (raw === null) {
    return { entries: [], present: false, problem: null }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { entries: [], present: true, problem: 'stored plugin list is not valid JSON' }
  }
  if (!Array.isArray(parsed)) {
    return { entries: [], present: true, problem: 'stored plugin list is not an array' }
  }
  const entries: LegacyPlugin[] = []
  let dropped = 0
  for (const item of parsed) {
    const entry = readEntry(item)
    if (entry) {
      entries.push(entry)
    } else {
      dropped += 1
    }
  }
  return {
    entries,
    present: true,
    problem: dropped > 0 ? `${dropped} stored entries were dropped` : null,
  }
}

/** 删除旧版记录；迁移成功后调用，失败只回传 false */
export const clearLegacyInstalled = (): boolean => {
  try {
    localStorage.removeItem(STORAGE_KEY)
    return true
  } catch {
    return false
  }
}
