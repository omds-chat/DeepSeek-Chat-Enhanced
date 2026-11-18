import type { StorageCapability } from '../dsc-plugin-engine/types.js'
import type { MarketSource } from './types.js'

/** plugins:storage 中保存来源配置的键 */
export const KEY_SOURCES = 'market-sources'

/** 允许走 http 的本机回环主机，与引擎的插件来源判定保持一致 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * 内置来源。awesome 依次尝试 CDN 分发、raw 兜底与 Pages 兜底，
 * inner 只走 Pages；顺序即优先级。
 */
export const DEFAULT_SOURCES: readonly MarketSource[] = [
  {
    id: 'awesome',
    name: 'awesome',
    builtin: true,
    baseUrls: [
      'https://cdn.jsdelivr.net/gh/omdsc-dev/awesome-dsc-plugin@main/',
      'https://raw.githubusercontent.com/omdsc-dev/awesome-dsc-plugin/main/',
      'https://omdsc-dev.github.io/awesome-dsc-plugin/',
    ],
  },
  {
    id: 'inner',
    name: 'inner',
    builtin: true,
    baseUrls: ['https://omdsc-dev.github.io/dsc-inner-plugin/'],
  },
]

/** 来源地址判定：https 任意主机，或 http 的本机回环地址 */
export const isSourceUrl = (value: string): boolean => {
  let target: URL
  try {
    target = new URL(value)
  } catch {
    return false
  }
  if (target.protocol === 'https:') {
    return true
  }
  return target.protocol === 'http:' && LOCAL_HOSTS.has(target.hostname)
}

/** 规范化 base_url：去掉查询与哈希，补齐尾部斜杠；非法地址返回 null */
export const normalizeBaseUrl = (value: string): string | null => {
  const trimmed = value.trim()
  if (trimmed === '' || !isSourceUrl(trimmed)) {
    return null
  }
  const target = new URL(trimmed)
  target.search = ''
  target.hash = ''
  const href = target.href
  return href.endsWith('/') ? href : href + '/'
}

/** 规范化一组 base_url；丢弃非法项与重复项，保留顺序 */
export const normalizeBaseUrls = (values: readonly string[]): string[] => {
  const urls: string[] = []
  for (const value of values) {
    const url = normalizeBaseUrl(value)
    if (url !== null && !urls.includes(url)) {
      urls.push(url)
    }
  }
  return urls
}

/** 把多行文本切成地址列表；空行忽略 */
export const splitUrls = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFilled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

/** 校验单条来源配置；结构不符返回 null */
const parseSource = (value: unknown): MarketSource | null => {
  if (!isRecord(value)) {
    return null
  }
  const { id, name, baseUrls, builtin } = value
  if (!isFilled(id) || !isFilled(name) || !Array.isArray(baseUrls)) {
    return null
  }
  const urls: string[] = []
  for (const item of baseUrls) {
    if (typeof item !== 'string') {
      return null
    }
    const url = normalizeBaseUrl(item)
    if (url !== null && !urls.includes(url)) {
      urls.push(url)
    }
  }
  if (urls.length === 0) {
    return null
  }
  return {
    id: id.trim(),
    name: name.trim(),
    baseUrls: urls,
    builtin: builtin === true,
  }
}

/** 解析持久化的来源列表；整体结构不符返回 null，由调用方退回默认值 */
export const parseSources = (raw: unknown): MarketSource[] | null => {
  if (!isRecord(raw) || !Array.isArray(raw.sources)) {
    return null
  }
  const sources: MarketSource[] = []
  const seen = new Set<string>()
  for (const item of raw.sources) {
    const source = parseSource(item)
    if (!source || seen.has(source.id)) {
      continue
    }
    seen.add(source.id)
    sources.push(source)
  }
  return sources.length === 0 ? null : sources
}

/** 读取来源配置；没有配置或配置损坏时返回内置默认值 */
export const readSources = (storage: StorageCapability): MarketSource[] => {
  try {
    const parsed = parseSources(storage.get(KEY_SOURCES))
    if (parsed) {
      return parsed
    }
  } catch {
    // 读取失败时退回默认来源
  }
  return DEFAULT_SOURCES.map((source) => ({ ...source, baseUrls: [...source.baseUrls] }))
}

/** 写回来源配置；失败只返回 false，不抛出 */
export const writeSources = (storage: StorageCapability, sources: MarketSource[]): boolean => {
  try {
    storage.set(KEY_SOURCES, { sources })
    return true
  } catch {
    return false
  }
}
