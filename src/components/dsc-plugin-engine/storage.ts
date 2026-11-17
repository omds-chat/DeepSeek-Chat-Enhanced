import { APP_NAME } from '../../brand.js'
import { readManifest } from './registry.js'
import type { PluginManifest, PluginSource } from './types.js'

/** 安装记录的 localStorage 键 */
const STORAGE_KEY = `${APP_NAME}:plugins`

/** 一条持久化的安装记录 */
export type PersistedPlugin = {
  manifest: PluginManifest
  source: PluginSource
  enabled: boolean
}

/** 读取结果；problem 描述读取过程中丢弃的内容 */
export type LoadInstalledResult = {
  entries: PersistedPlugin[]
  problem: string | null
}

/** 落盘结果；失败不抛错，由调用方记日志 */
export type SaveInstalledResult = { ok: true } | { ok: false; reason: string }

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

const readEntry = (value: unknown): PersistedPlugin | null => {
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

/** 读取安装记录；单条损坏只丢弃该条，不整体失败 */
export const loadInstalled = (): LoadInstalledResult => {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return { entries: [], problem: 'localStorage is not available' }
  }
  if (raw === null) {
    return { entries: [], problem: null }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { entries: [], problem: 'stored plugin list is not valid JSON' }
  }
  if (!Array.isArray(parsed)) {
    return { entries: [], problem: 'stored plugin list is not an array' }
  }
  const entries: PersistedPlugin[] = []
  let dropped = 0
  for (const item of parsed) {
    const entry = readEntry(item)
    if (entry) {
      entries.push(entry)
    } else {
      dropped += 1
    }
  }
  return { entries, problem: dropped > 0 ? `${dropped} stored entries were dropped` : null }
}

/** 写入安装记录；失败只回传原因 */
export const saveInstalled = (entries: readonly PersistedPlugin[]): SaveInstalledResult => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
