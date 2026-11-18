import { APP_NAME } from '../../brand.js'

/** 单插件数据总量上限（字节） */
const MAX_DATA_BYTES = 64 * 1024
/** localStorage 键前缀 */
const KEY_PREFIX = `${APP_NAME}:plugin-data:`
/** 插件 id 规则；与引擎清单校验保持一致 */
const ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/
/** 单条数据键名上限 */
const MAX_KEY_LENGTH = 64

/** 单个插件的键值对象 */
export type PluginDataStore = Record<string, unknown>

/** 单个插件遗留数据的占用统计 */
export type PluginDataUsage = {
  pluginId: string
  /** 序列化后的字节数 */
  bytes: number
  /** 顶层键数量 */
  keys: number
}

/** 插件数据被拒绝的原因；供引擎映射文案 */
export type PluginDataRejectReason = 'invalid' | 'quota' | 'serialize' | 'storage'

/** 插件数据读写失败 */
export class PluginDataError extends Error {
  constructor(
    readonly reason: PluginDataRejectReason,
    detail: string
  ) {
    super(`dsc-core: plugins:storage rejected (${reason}): ${detail}`)
    this.name = 'PluginDataError'
  }
}

const encoder = new TextEncoder()

const storageKey = (pluginId: string): string => {
  if (!ID_PATTERN.test(pluginId)) {
    throw new PluginDataError('invalid', 'plugin id is not valid')
  }
  return `${KEY_PREFIX}${pluginId}`
}

const entryKey = (key: string): string => {
  if (typeof key !== 'string' || key.trim() === '' || key.length > MAX_KEY_LENGTH) {
    throw new PluginDataError('invalid', 'data key is not valid')
  }
  return key
}

/** 值本身必须可 JSON 序列化，否则抛错 */
const ensureSerializable = (value: unknown): void => {
  const type = typeof value
  if (value === undefined || type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new PluginDataError('serialize', `value of type ${type} is not JSON serializable`)
  }
  try {
    JSON.stringify(value)
  } catch {
    throw new PluginDataError('serialize', 'value cannot be serialized to JSON')
  }
}

/** 读取整个插件的键值对象；缺失或损坏时返回空对象 */
export const readPluginData = (pluginId: string): PluginDataStore => {
  const key = storageKey(pluginId)
  let raw: string | null
  try {
    raw = localStorage.getItem(key)
  } catch {
    throw new PluginDataError('storage', 'localStorage is not available')
  }
  if (raw === null) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    return parsed as PluginDataStore
  } catch {
    return {}
  }
}

/** 读取单条数据；键不存在时返回 null */
export const readPluginEntry = (pluginId: string, key: string): { value: unknown } | null => {
  const name = entryKey(key)
  const data = readPluginData(pluginId)
  return Object.hasOwn(data, name) ? { value: data[name] } : null
}

/** 写入单条数据；超限或无法序列化时抛错 */
export const writePluginEntry = (pluginId: string, key: string, value: unknown): void => {
  const name = entryKey(key)
  ensureSerializable(value)
  const next: PluginDataStore = { ...readPluginData(pluginId), [name]: value }
  let text: string
  try {
    text = JSON.stringify(next)
  } catch {
    throw new PluginDataError('serialize', 'plugin data cannot be serialized to JSON')
  }
  if (encoder.encode(text).byteLength > MAX_DATA_BYTES) {
    throw new PluginDataError('quota', `plugin data exceeds ${MAX_DATA_BYTES} bytes`)
  }
  try {
    localStorage.setItem(storageKey(pluginId), text)
  } catch {
    throw new PluginDataError('storage', 'localStorage write failed')
  }
}

/** 删除单条数据；删空后移除整个键 */
export const removePluginEntry = (pluginId: string, key: string): void => {
  const name = entryKey(key)
  const data = readPluginData(pluginId)
  const next: PluginDataStore = {}
  for (const [entry, item] of Object.entries(data)) {
    if (entry !== name) {
      next[entry] = item
    }
  }
  const target = storageKey(pluginId)
  try {
    if (Object.keys(next).length === 0) {
      localStorage.removeItem(target)
      return
    }
    localStorage.setItem(target, JSON.stringify(next))
  } catch {
    throw new PluginDataError('storage', 'localStorage write failed')
  }
}

/** 统计单个键内的顶层条目数；无法解析时按 0 计 */
const countEntries = (raw: string): number => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return 0
    }
    return Object.keys(parsed).length
  } catch {
    return 0
  }
}

/** 收集全部插件数据键；localStorage 不可用时返回空数组 */
const collectKeys = (): string[] => {
  const keys: string[] = []
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key !== null && key.startsWith(KEY_PREFIX)) {
        keys.push(key)
      }
    }
  } catch {
    return []
  }
  return keys
}

/**
 * 列出全部插件的遗留数据，按字节数降序。
 * 卸载不再清理插件数据，这些条目就是卸载后保留的旧数据；localStorage 不可用时返回空数组。
 */
export const listPluginData = (): PluginDataUsage[] => {
  const usages: PluginDataUsage[] = []
  for (const key of collectKeys()) {
    let raw: string | null
    try {
      raw = localStorage.getItem(key)
    } catch {
      return []
    }
    if (raw === null) {
      continue
    }
    usages.push({
      pluginId: key.slice(KEY_PREFIX.length),
      bytes: encoder.encode(raw).byteLength,
      keys: countEntries(raw),
    })
  }
  return usages.sort((left, right) => right.bytes - left.bytes)
}

/** 判断单个插件是否遗留了数据；id 非法或 localStorage 不可用时按无数据计 */
export const hasPluginData = (pluginId: string): boolean => {
  if (!ID_PATTERN.test(pluginId)) {
    return false
  }
  try {
    return localStorage.getItem(`${KEY_PREFIX}${pluginId}`) !== null
  } catch {
    return false
  }
}

/**
 * 清除单个插件的全部数据。
 * 插件数据按 id 收敛在一个键内，删除该键即清空；由数据管理界面调用。
 */
export const clearPluginData = (pluginId: string): void => {
  const target = storageKey(pluginId)
  try {
    localStorage.removeItem(target)
  } catch {
    throw new PluginDataError('storage', 'localStorage write failed')
  }
}

/** 清除全部插件数据；localStorage 不可用时静默返回 */
export const clearAllPluginData = (): void => {
  for (const key of collectKeys()) {
    try {
      localStorage.removeItem(key)
    } catch {
      return
    }
  }
}
