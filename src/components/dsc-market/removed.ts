import type { NetCapability } from '../dsc-plugin-engine/types.js'
import { normalizeBaseUrl } from './sources.js'
import type { LocalizedText } from './types.js'

/** 已移除插件清单在来源站点上的固定位置 */
export const REMOVED_CATALOG_PATH = 'catalog/removed.json'
/** 清单请求的最长等待时间（毫秒）；与来源目录数据同一口径，失败直接静默 */
export const REMOVED_TIMEOUT = 1000
/** 本实现认识的清单结构版本 */
const SCHEMA_VERSION = 1

/** 清单条目：插件名、原先的分发站点基址、移除时的版本与可选说明 */
export type RemovedEntry = {
  name: string
  /** 原先的分发站点基址，已按 URL 规范化并补齐尾部斜杠 */
  baseUrls: string[]
  /** 移除时的插件版本号；来源未填时为空串 */
  removedIn: string
  /** 可选说明；来源只给一种语言时两侧同一句，缺失时为 null */
  note: LocalizedText | null
}

/**
 * 判定结论。
 * removed 表示命中某条清单；absent 表示至少有一份清单可达但没有命中；
 * undetermined 表示清单全部不可达，此时不作任何判断。
 */
export type RemovedVerdict =
  | { state: 'removed'; entry: RemovedEntry; baseUrl: string }
  | { state: 'absent' }
  | { state: 'undetermined' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFilled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

/** 拼接来源内的资源地址；baseUrl 已保证以斜杠结尾 */
const joinUrl = (baseUrl: string, path: string): string => {
  try {
    return new URL(path, baseUrl).href
  } catch {
    return baseUrl + path
  }
}

/** 规范化待判定的产物地址：去掉查询与哈希，其余保持原样；非法地址返回 null */
export const normalizeTargetUrl = (value: string): string | null => {
  try {
    const target = new URL(value.trim())
    target.search = ''
    target.hash = ''
    return target.href
  } catch {
    return null
  }
}

/** 读可选说明：接受单语字符串或双语对象，缺失时返回 null */
const readNote = (value: unknown): LocalizedText | null => {
  if (typeof value === 'string') {
    const text = value.trim()
    return text === '' ? null : { 'zh-CN': text, 'en-US': text }
  }
  if (isRecord(value)) {
    const zh = isFilled(value['zh-CN']) ? value['zh-CN'].trim() : ''
    const en = isFilled(value['en-US']) ? value['en-US'].trim() : ''
    if (zh === '' && en === '') {
      return null
    }
    return { 'zh-CN': zh === '' ? en : zh, 'en-US': en === '' ? zh : en }
  }
  return null
}

/**
 * 解析清单文本。
 * 结构版本不符、不是对象、removed 不是数组时返回 null；单条不合格时跳过该条，不影响其余条目。
 */
export const parseRemovedCatalog = (text: string): RemovedEntry[] | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.removed)) {
    return null
  }
  const entries: RemovedEntry[] = []
  for (const item of parsed.removed) {
    if (!isRecord(item) || !isFilled(item.name)) {
      continue
    }
    // base_url 是条目原先的分发站点基址，按单个地址书写；也接受同义的多地址写法
    const raw = item.base_url
    const candidates = Array.isArray(raw) ? raw : [raw]
    const baseUrls: string[] = []
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') {
        continue
      }
      const baseUrl = normalizeBaseUrl(candidate)
      if (baseUrl !== null && !baseUrls.includes(baseUrl)) {
        baseUrls.push(baseUrl)
      }
    }
    if (baseUrls.length === 0) {
      continue
    }
    entries.push({
      name: item.name.trim(),
      baseUrls,
      removedIn: isFilled(item.removed_in) ? item.removed_in.trim() : '',
      note: readNote(item.note),
    })
  }
  return entries
}

/**
 * 在若干条清单里匹配用户给的地址。
 * 按前缀匹配，基址与地址都先做 URL 规范化（去掉查询与哈希、补齐基址尾部斜杠）；
 * 多条命中时取最长基址，即最具体的那个来源。
 */
export const matchRemoved = (
  url: string,
  entries: readonly RemovedEntry[]
): { entry: RemovedEntry; baseUrl: string } | null => {
  const target = normalizeTargetUrl(url)
  if (target === null) {
    return null
  }
  let hit: { entry: RemovedEntry; baseUrl: string } | null = null
  for (const entry of entries) {
    for (const baseUrl of entry.baseUrls) {
      if (!target.startsWith(baseUrl)) {
        continue
      }
      if (hit === null || baseUrl.length > hit.baseUrl.length) {
        hit = { entry, baseUrl }
      }
    }
  }
  return hit
}

/** 读取清单文本；超时、网络失败与非 2xx 响应都返回 null */
const requestText = async (
  net: NetCapability,
  url: string,
  timeoutMs: number
): Promise<string | null> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await net.getText(url, { signal: controller.signal })
    return response.text
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 判定产物地址是否指向已被来源移除的插件。
 * 并发请求各来源全部 base_url 下的清单，单个请求短超时，失败静默；
 * 结构不符的清单同样按不可达处理，不参与判定。只读，不写任何状态。
 */
export const checkRemoved = async (
  net: NetCapability,
  baseUrls: readonly string[],
  url: string,
  timeoutMs: number = REMOVED_TIMEOUT
): Promise<RemovedVerdict> => {
  const bases: string[] = []
  for (const value of baseUrls) {
    const baseUrl = normalizeBaseUrl(value)
    if (baseUrl !== null && !bases.includes(baseUrl)) {
      bases.push(baseUrl)
    }
  }
  if (bases.length === 0) {
    return { state: 'undetermined' }
  }
  const texts = await Promise.all(
    bases.map((baseUrl) => requestText(net, joinUrl(baseUrl, REMOVED_CATALOG_PATH), timeoutMs))
  )
  const entries: RemovedEntry[] = []
  let reachable = false
  for (const text of texts) {
    if (text === null) {
      continue
    }
    const parsed = parseRemovedCatalog(text)
    if (parsed === null) {
      continue
    }
    reachable = true
    for (const entry of parsed) {
      entries.push(entry)
    }
  }
  if (!reachable) {
    return { state: 'undetermined' }
  }
  const hit = matchRemoved(url, entries)
  return hit === null ? { state: 'absent' } : { state: 'removed', entry: hit.entry, baseUrl: hit.baseUrl }
}
