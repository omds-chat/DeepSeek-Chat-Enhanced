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
