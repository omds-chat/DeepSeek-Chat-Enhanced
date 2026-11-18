import type { TranslationKey } from '../../i18n/index.js'
import { CORE_CAPABILITIES, type CoreCapabilityId } from '../dsc-core/types.js'
import type {
  NetCapability,
  PluginManifest,
  PluginSourceType,
  StorageCapability,
} from '../dsc-plugin-engine/types.js'
import { createDownloadReporter } from './count.js'
import { normalizeBaseUrls, readSources, writeSources } from './sources.js'
import { resolveSourceTrust } from './trust.js'
import type {
  CatalogPlugin,
  InstallPlan,
  LocalizedText,
  MarketSource,
  RuntimeMeta,
  SourceMeta,
  SourceRuntime,
  SourceTrust,
  TrustFailure,
} from './types.js'

/** 单个请求的最长等待时间（毫秒）；超时立刻切下一个 base_url */
export const REQUEST_TIMEOUT = 1000
/** 目录缓存有效期（毫秒）；只做内存缓存 */
const CACHE_TTL = 5 * 60 * 1000
/** 目录并发拉取上限 */
const CONCURRENCY = 4
/** 三元版本号 */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
/** 路径段：作者名、插件名与版本号都要能安全拼进地址 */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 对外查询与操作接口 */
export type MarketClient = {
  /** 状态版本号；配合 useSyncExternalStore 触发重渲染 */
  version(): number
  subscribe(listener: () => void): () => void
  sources(): MarketSource[]
  runtime(id: string): SourceRuntime | null
  selected(): string | null
  select(id: string): void
  refresh(id: string, force?: boolean): Promise<SourceRuntime | null>
  addSource(name: string, baseUrls: readonly string[]): string | null
  removeSource(id: string): boolean
  moveSource(id: string, delta: -1 | 1): boolean
  setBaseUrls(id: string, baseUrls: readonly string[]): boolean
  plan(id: string, plugin: CatalogPlugin): InstallPlan | null
  countInstall(id: string, plugin: CatalogPlugin): void
}

/** 目录条目 */
type CatalogEntry = { name: string; author: string; tags: string[] }

/** 版本清单 */
type VersionList = { latest: string; versions: string[] }

/** 来源解析结果；不可达时 baseUrl 与 meta 为 null */
type ResolveOutcome = {
  reachable: boolean
  baseUrl: string | null
  meta: SourceMeta | null
  trust: SourceTrust
  trustFailure: TrustFailure | null
  /** 来自 online-data 信任清单的合集 EEC 证书 PEM；未列入清单时为 null */
  eec: string | null
  eecFromTrustList: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFilled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

const isSegment = (value: string): boolean =>
  SEGMENT_PATTERN.test(value) && value !== '.' && value !== '..'

/** 拼接来源内的资源地址；base_url 已保证以斜杠结尾 */
const joinUrl = (baseUrl: string, path: string): string => {
  try {
    return new URL(path, baseUrl).href
  } catch {
    return baseUrl + path
  }
}

/** 读取文本资源；超时或失败都返回 null，由调用方切下一个地址 */
const requestText = async (net: NetCapability, url: string): Promise<string | null> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    const response = await net.getText(url, { signal: controller.signal })
    return response.text
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** 解析来源 meta.json；缺失字段按关闭处理 */
export const parseSourceMeta = (text: string): SourceMeta | null => {
  const parsed = parseJson(text)
  if (!isRecord(parsed)) {
    return null
  }
  const enabled = parsed.DOWNLOAD_COUNT_ENABLE === true
  const api = typeof parsed.DOWNLOAD_COUNT_API === 'string' ? parsed.DOWNLOAD_COUNT_API.trim() : ''
  const apiAllowed = enabled && api !== '' && isApiUrl(api)
  return {
    downloadCountEnabled: apiAllowed,
    downloadCountApi: apiAllowed ? api : '',
    apiNeedIp: parsed.API_NEED_IP === true,
  }
}

/** 计数接口地址只接受 https 或本机回环，与来源地址同一判定 */
const isApiUrl = (value: string): boolean => {
  let target: URL
  try {
    target = new URL(value)
  } catch {
    return false
  }
  if (target.protocol === 'https:') {
    return true
  }
  return (
    target.protocol === 'http:' &&
    (target.hostname === 'localhost' || target.hostname === '127.0.0.1' || target.hostname === '[::1]')
  )
}

/** 解析 datalog.json；不合格条目跳过并计数 */
export const parseDatalog = (text: string): { entries: CatalogEntry[]; skipped: number } | null => {
  const parsed = parseJson(text)
  if (!Array.isArray(parsed)) {
    return null
  }
  const entries: CatalogEntry[] = []
  const seen = new Set<string>()
  let skipped = 0
  for (const item of parsed) {
    if (!isRecord(item)) {
      skipped += 1
      continue
    }
    const name = item.plugin_name
    const author = item.author
    if (!isFilled(name) || !isFilled(author)) {
      skipped += 1
      continue
    }
    const pluginName = name.trim()
    const authorName = author.trim()
    if (!isSegment(pluginName) || !isSegment(authorName)) {
      skipped += 1
      continue
    }
    const key = authorName + '/' + pluginName
    if (seen.has(key)) {
      skipped += 1
      continue
    }
    seen.add(key)
    const tags: string[] = []
    if (Array.isArray(item.tag)) {
      for (const tag of item.tag) {
        if (typeof tag === 'string' && tag.trim() !== '') {
          tags.push(tag.trim())
        }
      }
    }
    entries.push({ name: pluginName, author: authorName, tags })
  }
  return { entries, skipped }
}

/** 解析 versions.json；latest 必须是合法版本号 */
export const parseVersions = (text: string): VersionList | null => {
  const parsed = parseJson(text)
  if (!isRecord(parsed) || typeof parsed.latest !== 'string') {
    return null
  }
  const latest = parsed.latest.trim()
  if (!VERSION_PATTERN.test(latest)) {
    return null
  }
  const versions: string[] = [latest]
  if (Array.isArray(parsed.versions)) {
    for (const item of parsed.versions) {
      if (typeof item !== 'string') {
        continue
      }
      const version = item.trim()
      if (VERSION_PATTERN.test(version) && !versions.includes(version)) {
        versions.push(version)
      }
    }
  }
  return { latest, versions }
}

/** 把插件名转成引擎接受的插件 id；@scope/name 取 name 部分 */
export const toPluginId = (name: string): string | null => {
  const slash = name.startsWith('@') ? name.indexOf('/') : -1
  const base = slash >= 0 ? name.slice(slash + 1) : name
  const id = base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return /^[a-z][a-z0-9-]*$/.test(id) ? id : null
}

/** 双语文案归一化；缺失的一侧用另一侧补 */
const readDescription = (value: unknown): LocalizedText => {
  if (typeof value === 'string') {
    return { 'zh-CN': value, 'en-US': value }
  }
  if (isRecord(value)) {
    const zh = typeof value['zh-CN'] === 'string' ? value['zh-CN'] : ''
    const en = typeof value['en-US'] === 'string' ? value['en-US'] : ''
    return { 'zh-CN': zh || en, 'en-US': en || zh }
  }
  return { 'zh-CN': '', 'en-US': '' }
}

/** 读清单里的能力声明；缺字段或含未知能力时返回 null，交给产物自带的 manifest */
const readCapabilities = (value: unknown): CoreCapabilityId[] | null => {
  if (!Array.isArray(value)) {
    return null
  }
  const capabilities: CoreCapabilityId[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !CORE_CAPABILITIES.includes(item as CoreCapabilityId)) {
      return null
    }
    const capability = item as CoreCapabilityId
    if (!capabilities.includes(capability)) {
      capabilities.push(capability)
    }
  }
  return capabilities
}

/** 解析运行时 meta.json；name 与 version 必填 */
export const parseRuntimeMeta = (
  text: string
): { meta: RuntimeMeta; manifest: PluginManifest | null } | null => {
  const parsed = parseJson(text)
  if (!isRecord(parsed)) {
    return null
  }
  const { name, version } = parsed
  if (!isFilled(name) || !isFilled(version)) {
    return null
  }
  const meta: RuntimeMeta = {
    name: name.trim(),
    version: version.trim(),
    license: typeof parsed.license === 'string' ? parsed.license : '',
    author: typeof parsed.author === 'string' ? parsed.author : '',
    description: readDescription(parsed.description),
    repoLink: typeof parsed.repo_link === 'string' ? parsed.repo_link : '',
    homePage: typeof parsed.home_page === 'string' ? parsed.home_page : '',
  }
  if (!VERSION_PATTERN.test(meta.version)) {
    return null
  }
  let manifest: PluginManifest | null = null
  const capabilities = readCapabilities(parsed.capabilities)
  const id = toPluginId(meta.name)
  if (capabilities && id) {
    manifest = { id, name: meta.name, version: meta.version, capabilities }
    const dependencies = parsed.dependencies
    if (isRecord(dependencies) && typeof dependencies.dsc === 'string' && dependencies.dsc !== '') {
      manifest.engines = dependencies.dsc
    }
  }
  return { meta, manifest }
}

/** 空态运行记录 */
const emptyRuntime = (id: string): SourceRuntime => ({
  id,
  state: 'idle',
  baseUrl: null,
  trust: 'unverified',
  trustFailure: null,
  meta: null,
  eec: null,
  eecFromTrustList: false,
  plugins: [],
  fetchedAt: null,
  skipped: 0,
  error: null,
})

/**
 * 按顺序解析来源：先按 base_url 找到可达的 meta.json，再套用 online-data 信任清单的结论。
 * 信任结论与来源是否可达相互独立：清单里没有该来源时按未校验处理。
 */
const resolveSource = async (net: NetCapability, source: MarketSource): Promise<ResolveOutcome> => {
  const outcome = resolveSourceTrust(source)
  for (const baseUrl of source.baseUrls) {
    const metaText = await requestText(net, joinUrl(baseUrl, 'meta.json'))
    if (metaText === null) {
      continue
    }
    const meta = parseSourceMeta(metaText)
    if (!meta) {
      continue
    }
    return { reachable: true, baseUrl, meta, ...outcome }
  }
  return { reachable: false, baseUrl: null, meta: null, ...outcome }
}

/** 拉取单个插件的版本与展示信息 */
const loadPlugin = async (
  net: NetCapability,
  baseUrl: string,
  entry: CatalogEntry
): Promise<CatalogPlugin | null> => {
  if (!isSegment(entry.name) || !isSegment(entry.author)) {
    return null
  }
  const basePath = 'plugins/' + entry.author + '/' + entry.name + '/'
  const versionsText = await requestText(net, joinUrl(baseUrl, basePath + 'versions.json'))
  const versionList = versionsText === null ? null : parseVersions(versionsText)
  if (!versionList) {
    return {
      key: entry.author + '/' + entry.name,
      name: entry.name,
      author: entry.author,
      tags: entry.tags,
      latest: null,
      versions: [],
      meta: null,
      manifest: null,
      error: 'pluginMarketVersionFailed',
    }
  }
  const detailPath = basePath + versionList.latest + '/'
  const metaText = await requestText(net, joinUrl(baseUrl, detailPath + 'meta.json'))
  const parsedMeta = metaText === null ? null : parseRuntimeMeta(metaText)
  return {
    key: entry.author + '/' + entry.name,
    name: entry.name,
    author: entry.author,
    tags: entry.tags,
    latest: versionList.latest,
    versions: versionList.versions,
    meta: parsedMeta?.meta ?? null,
    manifest: parsedMeta?.manifest ?? null,
    error: parsedMeta === null ? 'pluginMarketMetaFailed' : null,
  }
}

/** 拉取整个目录；并发受限，顺序在结果里统一排序 */
const loadCatalog = async (
  net: NetCapability,
  baseUrl: string,
  entries: CatalogEntry[]
): Promise<{ plugins: CatalogPlugin[]; skipped: number }> => {
  const plugins: CatalogPlugin[] = []
  let cursor = 0
  let skipped = 0
  const worker = async (): Promise<void> => {
    while (cursor < entries.length) {
      const entry = entries[cursor]
      cursor += 1
      const plugin = await loadPlugin(net, baseUrl, entry)
      if (plugin) {
        plugins.push(plugin)
      } else {
        skipped += 1
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, entries.length) }, () => worker())
  )
  plugins.sort((left, right) =>
    left.name === right.name
      ? left.author.localeCompare(right.author)
      : left.name.localeCompare(right.name)
  )
  return { plugins, skipped }
}

/** 来源 id 到插件来源类型；id 用合集目录名，来源类型仍是存储里的四个取值 */
const sourceTypeOf = (id: string): PluginSourceType => {
  if (id === 'awesome-dsc-plugin') {
    return 'awesome'
  }
  if (id === 'dsc-inner-plugin') {
    return 'inner'
  }
  return 'outer'
}

/** 创建市场客户端；所有失败都收敛成状态，不抛到宿主界面 */
export const createMarketClient = (
  net: NetCapability,
  storage: StorageCapability
): MarketClient => {
  let sourceList = readSources(storage)
  let selectedId: string | null = sourceList[0]?.id ?? null
  let stateVersion = 0
  const runtimes = new Map<string, SourceRuntime>()
  const inflight = new Map<string, Promise<SourceRuntime | null>>()
  const listeners = new Set<() => void>()
  const reporter = createDownloadReporter(net)

  const emit = () => {
    stateVersion += 1
    for (const listener of listeners) {
      listener()
    }
  }

  const runtimeOf = (id: string): SourceRuntime => runtimes.get(id) ?? emptyRuntime(id)

  const putRuntime = (runtime: SourceRuntime): SourceRuntime => {
    runtimes.set(runtime.id, runtime)
    emit()
    return runtime
  }

  const persist = () => {
    writeSources(storage, sourceList)
  }

  const runRefresh = async (source: MarketSource): Promise<SourceRuntime> => {
    putRuntime({ ...runtimeOf(source.id), state: 'loading', error: null })
    const outcome = await resolveSource(net, source)
    if (!outcome.reachable || outcome.baseUrl === null || outcome.meta === null) {
      return putRuntime({
        id: source.id,
        state: 'failed',
        baseUrl: null,
        trust: outcome.trust,
        trustFailure: outcome.trustFailure,
        meta: null,
        eec: outcome.eec,
        eecFromTrustList: outcome.eecFromTrustList,
        plugins: [],
        fetchedAt: null,
        skipped: 0,
        error: 'pluginMarketSourceFailed',
      })
    }
    const datalogText = await requestText(net, joinUrl(outcome.baseUrl, 'datalog.json'))
    let plugins: CatalogPlugin[] = []
    let skipped = 0
    let error: TranslationKey | null = null
    if (datalogText === null) {
      error = 'pluginMarketCatalogFailed'
    } else {
      const datalog = parseDatalog(datalogText)
      if (!datalog) {
        error = 'pluginMarketCatalogFailed'
      } else {
        const loaded = await loadCatalog(net, outcome.baseUrl, datalog.entries)
        plugins = loaded.plugins
        skipped = datalog.skipped + loaded.skipped
      }
    }
    return putRuntime({
      id: source.id,
      state: 'ready',
      baseUrl: outcome.baseUrl,
      trust: outcome.trust,
      trustFailure: outcome.trustFailure,
      meta: outcome.meta,
      eec: outcome.eec,
      eecFromTrustList: outcome.eecFromTrustList,
      plugins,
      fetchedAt: Date.now(),
      skipped,
      error,
    })
  }

  const refresh = async (id: string, force = false): Promise<SourceRuntime | null> => {
    const source = sourceList.find((item) => item.id === id)
    if (!source) {
      return null
    }
    const current = runtimes.get(id)
    if (
      !force &&
      current &&
      current.state === 'ready' &&
      current.fetchedAt !== null &&
      Date.now() - current.fetchedAt < CACHE_TTL
    ) {
      return current
    }
    const pending = inflight.get(id)
    if (pending) {
      return await pending
    }
    const task = runRefresh(source)
    inflight.set(id, task)
    try {
      return await task
    } finally {
      inflight.delete(id)
    }
  }

  const nextSourceId = (): string => {
    const taken = new Set(sourceList.map((source) => source.id))
    let index = sourceList.length + 1
    let id = 'custom-' + String(index)
    while (taken.has(id)) {
      index += 1
      id = 'custom-' + String(index)
    }
    return id
  }

  return {
    version: () => stateVersion,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    sources: () => sourceList.map((source) => ({ ...source, baseUrls: [...source.baseUrls] })),
    runtime: (id) => runtimes.get(id) ?? null,
    selected: () => selectedId,
    select: (id) => {
      if (sourceList.some((source) => source.id === id)) {
        selectedId = id
        emit()
      }
    },
    refresh,
    addSource: (name, baseUrls) => {
      const trimmed = name.trim()
      const urls = normalizeBaseUrls(baseUrls)
      if (trimmed === '' || urls.length === 0) {
        return null
      }
      const id = nextSourceId()
      sourceList = [...sourceList, { id, name: trimmed, baseUrls: urls, builtin: false }]
      persist()
      selectedId = id
      emit()
      return id
    },
    removeSource: (id) => {
      const source = sourceList.find((item) => item.id === id)
      if (!source || source.builtin || sourceList.length <= 1) {
        return false
      }
      sourceList = sourceList.filter((item) => item.id !== id)
      runtimes.delete(id)
      inflight.delete(id)
      if (selectedId === id) {
        selectedId = sourceList[0]?.id ?? null
      }
      persist()
      emit()
      return true
    },
    moveSource: (id, delta) => {
      const index = sourceList.findIndex((item) => item.id === id)
      const target = index + delta
      if (index < 0 || target < 0 || target >= sourceList.length) {
        return false
      }
      const next = [...sourceList]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      sourceList = next
      persist()
      emit()
      return true
    },
    setBaseUrls: (id, baseUrls) => {
      const source = sourceList.find((item) => item.id === id)
      if (!source) {
        return false
      }
      const urls = normalizeBaseUrls(baseUrls)
      if (urls.length === 0) {
        return false
      }
      sourceList = sourceList.map((item) =>
        item.id === id ? { ...item, baseUrls: urls } : item
      )
      // 地址变了，旧的解析结果与缓存全部作废
      runtimes.delete(id)
      inflight.delete(id)
      persist()
      emit()
      return true
    },
    plan: (id, plugin) => {
      const runtime = runtimes.get(id)
      // 信任校验未通过也允许生成安装计划：界面会提示，由用户自行判断
      if (!runtime || runtime.baseUrl === null) {
        return null
      }
      if (plugin.latest === null) {
        return null
      }
      if (!isSegment(plugin.name) || !isSegment(plugin.author) || !isSegment(plugin.latest)) {
        return null
      }
      const versionPath = 'plugins/' + plugin.author + '/' + plugin.name + '/' + plugin.latest + '/'
      const plan: InstallPlan = {
        url: joinUrl(runtime.baseUrl, versionPath + 'plugin.js'),
        sourceType: sourceTypeOf(id),
        sigUrl: joinUrl(runtime.baseUrl, versionPath + 'plugin.js.sig'),
        authorPubUrl: joinUrl(runtime.baseUrl, 'plugins/' + plugin.author + '/author_pub.pem'),
        authorSigUrl: joinUrl(runtime.baseUrl, versionPath + 'plugin.js.author.sig'),
      }
      // 来源列入信任清单时用清单里的证书验签，否则由引擎拉取来源自带的 eec.pem
      if (runtime.eec !== null) {
        plan.eec = runtime.eec
      } else {
        plan.eecUrl = joinUrl(runtime.baseUrl, 'eec.pem')
      }
      if (plugin.manifest) {
        plan.manifest = plugin.manifest
      }
      return plan
    },
    countInstall: (id, plugin) => {
      const runtime = runtimes.get(id)
      if (!runtime || !runtime.meta) {
        return
      }
      reporter.report(runtime.meta, plugin.name)
    },
  }
}
