import { isHttpsOrLocalUrl } from '../../utils/url.js'
import type { StorageCapability } from '../dsc-plugin-engine/types.js'
import type { MarketSource } from './types.js'

/** plugins:storage 中保存来源配置的键 */
export const KEY_SOURCES = 'market-sources'

/** 来源地址判定：https 任意主机，或 http 的回环地址；规则与引擎的插件来源判定共用 */
export const isSourceUrl = (value: string): boolean => isHttpsOrLocalUrl(value)

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

/** 构建时注入的本地来源地址：dev 由 .env 提供，production 恒为空串 */
const injectedInnerPages = (): string =>
  typeof __DSC_INNER_PLUGIN_PAGES_LINK__ === 'string' ? __DSC_INNER_PLUGIN_PAGES_LINK__ : ''

const injectedAwesomePages = (): string =>
  typeof __AWESOME_DSC_PLUGIN_PAGES_LINK__ === 'string' ? __AWESOME_DSC_PLUGIN_PAGES_LINK__ : ''

/**
 * 旧版内置来源 id 到合集目录名的映射。
 * 来源 id 现在与合集目录名一致，读取旧配置时按此表迁移，避免用户配置失效。
 */
const LEGACY_IDS: Record<string, string> = {
  awesome: 'awesome-dsc-plugin',
  inner: 'dsc-inner-plugin',
}

/**
 * 内置来源。id 与合集目录名一致，便于直接命中 trusted-manifest 信任清单；
 * 列表顺序即来源优先级，dsc-inner-plugin 在前，awesome-dsc-plugin 在后。
 * 单个来源内的 base_url 也按顺序尝试：awesome-dsc-plugin 依次尝试 CDN 分发、raw 兜底与 Pages 兜底，
 * dsc-inner-plugin 只走 Pages。
 */
/**
 * 单个来源的 base_url 列表：注入了合法的本地地址时只用本地那一个，不再列线上兜底。
 * 开发构建的语义是「不碰网络」，把线上地址留在候选里等于让它继续发请求。
 */
const sourceBaseUrls = (injected: string, online: readonly string[]): string[] => {
  const local = normalizeBaseUrl(injected)
  return local === null ? [...online] : [local]
}

export const DEFAULT_SOURCES: readonly MarketSource[] = [
  {
    id: 'dsc-inner-plugin',
    name: 'dsc-inner-plugin',
    builtin: true,
    baseUrls: sourceBaseUrls(injectedInnerPages(), ['https://omds-chat.github.io/dsc-inner-plugin/']),
  },
  {
    id: 'awesome-dsc-plugin',
    name: 'awesome-dsc-plugin',
    builtin: true,
    baseUrls: sourceBaseUrls(injectedAwesomePages(), [
      'https://cdn.jsdelivr.net/gh/omds-chat/awesome-dsc-plugin@main/',
      'https://raw.githubusercontent.com/omds-chat/awesome-dsc-plugin/main/',
      'https://omds-chat.github.io/awesome-dsc-plugin/',
    ]),
  },
]

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
    if (!source) {
      continue
    }
    // 旧配置里的 awesome / inner 迁移到合集目录名形式的 id
    const id = LEGACY_IDS[source.id] ?? source.id
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    sources.push({ ...source, id })
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
