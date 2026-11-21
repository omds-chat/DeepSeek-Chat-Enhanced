import { APP_NAME } from '../../brand.js'

/**
 * 插件设置值的命名空间存储。
 * 与 plugins:storage 的插件数据(`${APP_NAME}:plugin-data:<id>`)完全分开:
 * 设置覆盖值落在独立前缀下, 插件用 storage.set 写不到这张表,
 * 读写只发生在引擎侧, 写入前由引擎按已登记的字段描述校验。
 * 默认值不落盘: 默认层来自插件登记的字段描述, 这里只存用户覆盖层。
 */

/** 单插件设置覆盖值总量上限(字节) */
const MAX_SETTINGS_BYTES = 16 * 1024
/** localStorage 键前缀 */
const KEY_PREFIX = `${APP_NAME}:plugin-settings:`
/** 插件 id 规则; 与引擎清单校验保持一致 */
const ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/
/** 单个字段键名上限 */
const MAX_KEY_LENGTH = 64

/** 单个插件的设置覆盖值对象 */
export type PluginSettingsStore = Record<string, unknown>

/** 插件设置读写被拒绝的原因; 供引擎映射错误 */
export type PluginSettingsRejectReason = 'invalid' | 'quota' | 'serialize' | 'storage'

/** 插件设置读写失败 */
export class PluginSettingsError extends Error {
  constructor(
    readonly reason: PluginSettingsRejectReason,
    detail: string
  ) {
    super(`dsc-core: plugin settings rejected (${reason}): ${detail}`)
    this.name = 'PluginSettingsError'
  }
}

const encoder = new TextEncoder()

const storageKey = (pluginId: string): string => {
  if (!ID_PATTERN.test(pluginId)) {
    throw new PluginSettingsError('invalid', 'plugin id is not valid')
  }
  return `${KEY_PREFIX}${pluginId}`
}

const entryKey = (key: string): string => {
  if (typeof key !== 'string' || key.trim() === '' || key.length > MAX_KEY_LENGTH) {
    throw new PluginSettingsError('invalid', 'setting key is not valid')
  }
  return key
}

/** 值本身必须可 JSON 序列化, 否则抛错 */
const ensureSerializable = (value: unknown): void => {
  const type = typeof value
  if (value === undefined || type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new PluginSettingsError('serialize', `value of type ${type} is not JSON serializable`)
  }
  try {
    JSON.stringify(value)
  } catch {
    throw new PluginSettingsError('serialize', 'value cannot be serialized to JSON')
  }
}

/** 读取单个插件的设置覆盖值; 缺失或损坏时返回空对象 */
export const readPluginSettingsOverrides = (pluginId: string): PluginSettingsStore => {
  const key = storageKey(pluginId)
  let raw: string | null
  try {
    raw = localStorage.getItem(key)
  } catch {
    throw new PluginSettingsError('storage', 'localStorage is not available')
  }
  if (raw === null) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    return parsed as PluginSettingsStore
  } catch {
    return {}
  }
}

/** 写入单个设置覆盖值; 超限或无法序列化时抛错 */
export const writePluginSettingEntry = (pluginId: string, key: string, value: unknown): void => {
  const name = entryKey(key)
  ensureSerializable(value)
  const next: PluginSettingsStore = { ...readPluginSettingsOverrides(pluginId), [name]: value }
  let text: string
  try {
    text = JSON.stringify(next)
  } catch {
    throw new PluginSettingsError('serialize', 'plugin settings cannot be serialized to JSON')
  }
  if (encoder.encode(text).byteLength > MAX_SETTINGS_BYTES) {
    throw new PluginSettingsError('quota', `plugin settings exceed ${MAX_SETTINGS_BYTES} bytes`)
  }
  try {
    localStorage.setItem(storageKey(pluginId), text)
  } catch {
    throw new PluginSettingsError('storage', 'localStorage write failed')
  }
}

/** 删除单个设置覆盖值; 删空后移除整个键 */
export const removePluginSettingEntry = (pluginId: string, key: string): void => {
  const name = entryKey(key)
  const data = readPluginSettingsOverrides(pluginId)
  const next: PluginSettingsStore = {}
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
    throw new PluginSettingsError('storage', 'localStorage write failed')
  }
}

/** 清除单个插件的全部设置覆盖值; 由引擎在卸载清理时调用 */
export const clearPluginSettings = (pluginId: string): void => {
  const target = storageKey(pluginId)
  try {
    localStorage.removeItem(target)
  } catch {
    throw new PluginSettingsError('storage', 'localStorage write failed')
  }
}
