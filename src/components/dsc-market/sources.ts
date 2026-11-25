import { isHttpsOrLocalUrl } from '../../utils/url.js'
import type { StorageCapability } from '../dsc-plugin-engine/types.js'
import type { MarketSource, SourceKind } from './types.js'

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
 * 单个来源的 base_url 按 Pages -> raw -> jsDelivr 的顺序尝试：
 * Pages 承载构建产物；raw 与 jsDelivr 镜像 CI 维护的 latest 引用（每次发布重建的产物快照），
 * 绝不指向 main 一类的开发分支——市场取件表要的全部是构建产物，开发分支工作树上一样都没有，
 * 裸分支名是必然 404 的死路径。
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
    collectionName: 'dsc-inner-plugin',
    builtin: true,
    kind: 'inner',
    baseUrls: sourceBaseUrls(injectedInnerPages(), ['https://omds-chat.github.io/dsc-inner-plugin/']),
  },
  {
    id: 'awesome-dsc-plugin',
    name: 'awesome-dsc-plugin',
    collectionName: 'awesome-dsc-plugin',
    builtin: true,
    kind: 'awesome',
    baseUrls: sourceBaseUrls(injectedAwesomePages(), [
      'https://omds-chat.github.io/awesome-dsc-plugin/',
      'https://raw.githubusercontent.com/omds-chat/awesome-dsc-plugin/latest/',
      'https://cdn.jsdelivr.net/gh/omds-chat/awesome-dsc-plugin@latest/',
    ]),
  },
]

/**
 * 内置项判定：kind 不是 user 即为市场自带的默认来源。
 * 删除、改地址、改名与调序一律按这一条拒绝，不看调用方传进来的 id 长什么样。
 */
export const isBuiltinSource = (source: MarketSource): boolean => source.kind !== 'user'

/**
 * 可浏览来源：内部插件来源只在来源登记里占一行、供已安装页取目录，
 * 不作为市场目录与来源选择器的切换项。
 */
export const isBrowsableSource = (source: MarketSource): boolean => source.kind !== 'inner'

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

/** 内置来源的类别只由内置表决定；id 命中内置表时这就是答案 */
const builtinKindOf = (id: string): SourceKind | null => {
  const known = DEFAULT_SOURCES.find((source) => source.id === id)
  return known ? known.kind : null
}

/** 持久化的类别字段；只有三个取值之一才算数 */
const readKind = (value: unknown): SourceKind | null =>
  value === 'inner' || value === 'awesome' || value === 'user' ? value : null

/**
 * 还原来源类别：先按 id 认回内置表，再用持久化的 kind，
 * 再退回旧配置的 builtin 标记，最后按用户来源处理。
 * 旧配置没有 kind 也能读出内置项，来源本身不因缺字段被丢弃。
 */
const resolveKind = (id: string, persisted: SourceKind | null, builtin: unknown): SourceKind =>
  builtinKindOf(id) ?? persisted ?? (builtin === true ? 'awesome' : 'user')

/**
 * 持久化里的单条来源；kind 未定、合集标识名待补默认值，等 id 迁移之后再解析。
 * 旧数据没有 collectionName，读取时按 name 补齐，与引入该字段之前的口径一致。
 */
type ParsedSource = Omit<MarketSource, 'kind' | 'collectionName'> & {
  kind: SourceKind | null
  collectionName: string
}

/** 校验单条来源配置；结构不符返回 null */
const parseSource = (value: unknown): ParsedSource | null => {
  if (!isRecord(value)) {
    return null
  }
  const { id, name, collectionName, baseUrls, builtin, kind } = value
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
    collectionName: isFilled(collectionName) ? collectionName.trim() : name.trim(),
    baseUrls: urls,
    builtin: builtin === true,
    kind: readKind(kind),
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
    // 旧配置里的 awesome / inner 迁移到合集目录名形式的 id，类别按迁移后的 id 认
    const id = LEGACY_IDS[source.id] ?? source.id
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    const kind = resolveKind(id, source.kind, source.builtin)
    sources.push({
      id,
      name: source.name,
      collectionName: source.collectionName,
      baseUrls: source.baseUrls,
      builtin: kind !== 'user',
      kind,
    })
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
