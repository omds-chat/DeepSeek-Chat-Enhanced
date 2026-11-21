import type { TranslationKey } from '../../i18n/index.js'
import {
  createRevisionMemory,
  fetchManifest,
  hashMatches,
  manifestLayerKey,
  verifyManifest,
  type Manifest,
  type ManifestReader,
  type RevisionMemory,
} from '../../services/integrity/manifest.js'
import {
  fetchSiteManifest,
  SITE_SIGNATURE_SUFFIX,
  siteUrlOf,
  verifySiteFile,
  verifySiteManifest,
  type SignatureState,
  type SiteManifestFetch,
} from '../../services/integrity/site.js'
import { collectionCertPaths, normalizeCollectionId } from '../../services/trust/collection.js'
import { CORE_CAPABILITIES, type CoreCapabilityId } from '../dsc-core/types.js'
import { toPluginId } from '../dsc-plugin-engine/pluginId.js'
import type {
  NetCapability,
  PluginManifest,
  PluginSourceType,
  StorageCapability,
} from '../dsc-plugin-engine/types.js'
import { createDownloadReporter } from './count.js'
import { detectSourceModel, type SourceModel } from './model.js'
import { checkRemoved, type RemovedVerdict } from './removed.js'
import { normalizeBaseUrls, readSources, writeSources } from './sources.js'
import { resolveSourceTrust } from './trust.js'
import {
  dataBaseOf,
  locateInstalled,
  reinstallPathsOf,
  updateStatusOf,
  versionDirOf,
  versionsUrlOf,
  type InstalledLocation,
} from './updates.js'
import type {
  CatalogConclusions,
  CatalogPlugin,
  InstallPlan,
  LocalizedText,
  MarketSource,
  ReinstallPlan,
  RevisionWarning,
  RuntimeMeta,
  SourceMeta,
  SourceRuntime,
  SourceTrust,
  TrustFailure,
  UpdateReport,
  UpdateTarget,
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
/** 三层清单的 revision 记忆在插件存储里的键 */
const REVISION_KEY = 'manifest-revisions'
/** 清单与签名的请求上限（毫秒）；按字节取，与目录数据的 1 秒超时分开 */
const MANIFEST_TIMEOUT = 5000

/** 构建时注入的根证书 PEM；未注入时为空串 */
const embeddedRootCa = (): string => (typeof __ROOT_CA_PEM__ === 'string' ? __ROOT_CA_PEM__ : '')

/** 把文本还原成字节；目录文件按 UTF-8 文本分发，哈希按还原后的字节计算 */
const textBytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)

/** 把已取到的字节还原成文本；整站模型按字节取件，解析与哈希各用一份 */
const bytesText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

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
  /** 检查已安装插件的版本更新；无法判断的插件不出现在结果里 */
  checkUpdates(targets: readonly UpdateTarget[]): Promise<UpdateReport>
  /** 生成重新安装到指定版本的计划；地址结构不符时返回 null */
  reinstallPlan(target: UpdateTarget, version: string): ReinstallPlan | null
  /** 判定请求不到的产物地址是否指向已被来源移除的插件；清单全部不可达时为未判定 */
  checkRemoved(url: string): Promise<RemovedVerdict>
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
  /** 根 meta.json 的原文；L1 清单校验要用它的字节 */
  metaText: string | null
  trust: SourceTrust
  trustFailure: TrustFailure | null
  /** 来自 trusted-manifest 信任清单的合集 EEC 证书 PEM；未列入清单时为 null */
  eec: string | null
  eecFromTrustList: boolean
  /** 合集 EEC 证书链是否校验通过 */
  chainVerified: boolean
  /** 合集 id：源站点上证书路径 certs/<合集 id>/<合集 id>-eec.crt 要用它 */
  collectionId: string
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

/** 解析插件目录索引 plugins.json；不合格条目跳过并计数 */
export const parsePluginsIndex = (text: string): { entries: CatalogEntry[]; skipped: number } | null => {
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

/** 插件 id 规则由引擎侧统一给出，市场侧直接复用，两条安装路径得到同一个 id */
export { toPluginId }

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
  chainVerified: false,
  collectionId: '',
  model: 'unknown',
  plugins: [],
  fetchedAt: null,
  catalogVerified: false,
  revisionWarnings: [],
  skipped: 0,
  error: null,
})

/**
 * 按顺序解析来源：先按 base_url 找到可达的 meta.json，再套用 trusted-manifest 信任清单的结论。
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
    return { reachable: true, baseUrl, meta, metaText, ...outcome }
  }
  return { reachable: false, baseUrl: null, meta: null, metaText: null, ...outcome }
}

/** 一层清单的校验结论；verified 为 false 时 manifest 为 null */
type LayerCheck = {
  /** 该层相对来源根目录的路径；合集根为空串，其余以斜杠结尾 */
  layerPath: string
  verified: boolean
  manifest: Manifest | null
  revision: number | null
}

/** 一次目录拉取内共享的清单校验上下文 */
type LayerContext = {
  net: NetCapability
  /** 来源根目录，以斜杠结尾 */
  baseUrl: string
  /** 合集 EEC 证书 PEM；信任清单已登记时优先 */
  eec: string
  /** 构建时注入的根证书 PEM；为空时所有清单都按未校验处理 */
  rootCa: string
  memory: RevisionMemory
  /** 同一层只取一次 */
  layers: Map<string, Promise<LayerCheck>>
  /** 回退提示按层去重 */
  warnings: Map<string, RevisionWarning>
}

/** 层路径转成层号：合集根为 L1，作者目录为 L2，插件目录为 L3 */
const layerOf = (layerPath: string): RevisionWarning['layer'] => {
  if (layerPath === '') {
    return 'L1'
  }
  const depth = layerPath.split('/').filter((segment) => segment !== '').length
  return depth <= 2 ? 'L2' : 'L3'
}

/**
 * 取清单与签名的字节。
 * manifest.json.sig 是 CMS 的 DER 二进制，经 net 能力按文本读会把签名解坏，
 * 因此清单按字节取；目录数据文件仍走 net 能力，地址判定与超时口径不变。
 */
const manifestReader: ManifestReader = async (url) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT)
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal })
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 取并校验一层清单。
 * 没有根证书或合集证书、清单缺失、结构不符、验签失败都按未校验处理，不抛错；
 * 校验通过时把 revision 写进记忆，回退只记提示，不阻断浏览与安装。
 */
const loadLayer = (context: LayerContext, layerPath: string): Promise<LayerCheck> => {
  const key = manifestLayerKey(context.baseUrl, layerPath)
  const cached = context.layers.get(key)
  if (cached !== undefined) {
    return cached
  }
  const task = (async (): Promise<LayerCheck> => {
    const unverified: LayerCheck = { layerPath, verified: false, manifest: null, revision: null }
    if (context.rootCa === '' || context.eec === '') {
      return unverified
    }
    const fetched = await fetchManifest(context.baseUrl, layerPath, manifestReader)
    if (fetched.manifest === null || fetched.signature === null) {
      return unverified
    }
    const verdict = await verifyManifest(
      fetched.manifest,
      fetched.signature,
      context.eec,
      context.rootCa
    )
    if (!verdict.ok) {
      return unverified
    }
    const revision = fetched.manifest.revision
    const check = context.memory.record(key, revision)
    if (check.regressed && check.seen !== null) {
      context.warnings.set(key, {
        layer: layerOf(layerPath),
        path: layerPath,
        seen: check.seen,
        revision,
      })
    }
    return { layerPath, verified: true, manifest: fetched.manifest, revision }
  })()
  context.layers.set(key, task)
  return task
}

/**
 * 目录数据的校验策略。
 * 合集模型按层清单比哈希：open 取并校验该层 manifest.json，matches 比对该层文件的 SHA-512。
 * 整站模型按逐文件签名：open 只反映整站清单是否验签通过，matches 验该文件自己的 <路径>.sig。
 * 两种策略都只产出「通过 / 未通过」，未通过一律降级为未校验，不阻断浏览与安装。
 */
type CatalogVerifier = {
  /** 打开一层目录，取该层的校验材料 */
  open(layerPath: string): Promise<LayerCheck>
  /** 校验一层内的某个文件；bytes 是已取到的文件字节，缺失传 null */
  matches(check: LayerCheck, filePath: string, bytes: Uint8Array<ArrayBuffer> | null): Promise<boolean>
}

/** 合集模型：三层哈希清单 */
const createCollectionVerifier = (context: LayerContext): CatalogVerifier => ({
  open: (layerPath) => loadLayer(context, layerPath),
  matches: async (check, filePath, bytes) =>
    check.manifest === null || bytes === null
      ? false
      : await hashMatches(check.manifest, filePath, bytes),
})

/**
 * 整站模型：web_files.json 与逐文件签名。
 * 清单验签只做一次并缓存结论，清单未通过时该层一律按未校验处理；
 * 逐文件验签的对象是调用方已取到的那份字节，不重新取件，避免验签内容与实际消费内容不一致。
 */
const createSiteVerifier = (
  baseUrl: string,
  site: SiteManifestFetch,
  certPem: string,
  rootCa: string
): CatalogVerifier => {
  let state: Promise<SignatureState> | null = null
  const manifestState = (): Promise<SignatureState> => {
    state ??= verifySiteManifest(site, certPem, rootCa)
    return state
  }
  return {
    open: async (layerPath) => ({
      layerPath,
      verified: (await manifestState()) === 'verified',
      manifest: null,
      revision: null,
    }),
    matches: async (check, filePath, bytes) => {
      if (!check.verified || bytes === null || site.manifest === null) {
        return false
      }
      const path = check.layerPath + filePath
      const signature = await manifestReader(siteUrlOf(baseUrl, path) + SITE_SIGNATURE_SUFFIX)
      const verdict = await verifySiteFile({
        path,
        bytes,
        signature,
        manifest: site.manifest,
        certPem,
        rootCa,
      })
      return verdict === 'verified'
    },
  }
}

/** 未确认模型：两种模型的特征文件都不成立，目录照常展示，结论一律为未校验 */
const unverifiedVerifier: CatalogVerifier = {
  open: async (layerPath) => ({ layerPath, verified: false, manifest: null, revision: null }),
  matches: async () => false,
}

/** 一次目录拉取的上下文；层材料与校验策略分开，模型不同只换策略 */
type CatalogContext = {
  net: NetCapability
  /** 来源根目录，以斜杠结尾 */
  baseUrl: string
  /** 目录数据的校验策略；合集、整站与未确认三种 */
  verifier: CatalogVerifier
  /** 合集根目录数据是否已按 L1 清单或整站清单校验通过 */
  catalogVerified: boolean
  /** L1 清单的 revision；没有拿到 L1 清单或整站模型下为 null */
  l1Revision: number | null
}

/** 把已取到的各层 revision 收敛成安装记录要保存的结构 */
const revisionsOf = (
  l1: number | null,
  l2: number | null,
  l3: number | null
): CatalogConclusions['revisions'] => ({
  ...(l1 === null ? {} : { l1 }),
  ...(l2 === null ? {} : { l2 }),
  ...(l3 === null ? {} : { l3 }),
})

/**
 * 合集证书：信任清单已登记时优先用它，省一次请求；
 * 未登记时按 certs/<合集 id>/<合集 id>-eec.crt 取，取不到再退回旧站点的扁平路径
 * certs/<合集 id>-eec.crt 与最旧的 eec.pem，三档都失败时返回空串，由调用方按拿不到证书处理。
 */
const resolveCollectionEec = async (
  net: NetCapability,
  baseUrl: string,
  listed: string | null,
  collectionId: string
): Promise<string> => {
  if (listed !== null && listed !== '') {
    return listed
  }
  for (const path of collectionCertPaths(collectionId)) {
    const text = (await requestText(net, joinUrl(baseUrl, path))) ?? ''
    if (text !== '') {
      return text
    }
  }
  return ''
}

/**
 * 拉取单个插件的版本与展示信息。
 * 先用插件目录的材料校验 versions.json 与展示版本的 meta.json，再用作者目录的材料取作者公钥哈希；
 * 合集模型对应 L3 与 L2 清单，整站模型对应逐文件签名（没有 L2 清单，作者公钥哈希缺省）；
 * 材料缺失或验签失败时降级为未校验，目录照常展示。
 */
const loadPlugin = async (
  context: CatalogContext,
  entry: CatalogEntry
): Promise<CatalogPlugin | null> => {
  if (!isSegment(entry.name) || !isSegment(entry.author)) {
    return null
  }
  const authorPath = 'plugins/' + entry.author + '/'
  const basePath = authorPath + entry.name + '/'
  const [l2, l3] = await Promise.all([
    context.verifier.open(authorPath),
    context.verifier.open(basePath),
  ])
  const authorPubSha512 = l2.manifest?.files.find((file) => file.path === 'author_pub.pem')?.sha512
  const versionsText = await requestText(context.net, joinUrl(context.baseUrl, basePath + 'versions.json'))
  const versionList = versionsText === null ? null : parseVersions(versionsText)
  const versionsOk = await context.verifier.matches(
    l3,
    'versions.json',
    versionsText === null ? null : textBytes(versionsText)
  )
  const authorPub = authorPubSha512 === undefined ? {} : { authorPubSha512 }
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
      catalogVerified: false,
      conclusions: {
        catalogVerified: false,
        metaVerified: false,
        revisions: revisionsOf(context.l1Revision, l2.revision, l3.revision),
        ...authorPub,
      },
      error: 'pluginMarketVersionFailed',
    }
  }
  const detailPath = basePath + versionList.latest + '/'
  const metaText = await requestText(context.net, joinUrl(context.baseUrl, detailPath + 'meta.json'))
  const parsedMeta = metaText === null ? null : parseRuntimeMeta(metaText)
  const metaOk = await context.verifier.matches(
    l3,
    versionList.latest + '/meta.json',
    metaText === null ? null : textBytes(metaText)
  )
  const conclusions: CatalogConclusions = {
    catalogVerified: context.catalogVerified,
    metaVerified: l3.verified && versionsOk && metaOk,
    revisions: revisionsOf(context.l1Revision, l2.revision, l3.revision),
    ...authorPub,
  }
  return {
    key: entry.author + '/' + entry.name,
    name: entry.name,
    author: entry.author,
    tags: entry.tags,
    latest: versionList.latest,
    versions: versionList.versions,
    meta: parsedMeta?.meta ?? null,
    manifest: parsedMeta?.manifest ?? null,
    catalogVerified: conclusions.catalogVerified && conclusions.metaVerified,
    conclusions,
    error: parsedMeta === null ? 'pluginMarketMetaFailed' : null,
  }
}

/** 拉取整个目录；并发受限，顺序在结果里统一排序 */
const loadCatalog = async (
  context: CatalogContext,
  entries: CatalogEntry[]
): Promise<{ plugins: CatalogPlugin[]; skipped: number }> => {
  const plugins: CatalogPlugin[] = []
  let cursor = 0
  let skipped = 0
  const worker = async (): Promise<void> => {
    while (cursor < entries.length) {
      const entry = entries[cursor]
      cursor += 1
      const plugin = await loadPlugin(context, entry)
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
  /** 各层清单 revision 记忆：按层目录地址记录见过的最大 revision，只用于回退提示 */
  const revisionMemory = createRevisionMemory({
    read: () => {
      const value = storage.get(REVISION_KEY)
      const map: Record<string, number> = {}
      if (isRecord(value)) {
        for (const [key, item] of Object.entries(value)) {
          if (typeof item === 'number') {
            map[key] = item
          }
        }
      }
      return map
    },
    write: (value) => {
      storage.set(REVISION_KEY, value)
    },
  })
  /** 插件目录到目录结论的缓存；重新安装计划直接取用 */
  const conclusionsCache = new Map<string, CatalogConclusions>()

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

  /** 把 revision 回退提示挂到同址来源的运行态上；只提示，不改变来源结论 */
  const recordRevisionWarnings = (
    baseUrl: string,
    warnings: Iterable<RevisionWarning>
  ): void => {
    const owner = sourceList.find((source) =>
      source.baseUrls.some((base) => baseUrl.startsWith(base))
    )
    const runtime = owner ? (runtimes.get(owner.id) ?? null) : null
    if (runtime === null) {
      return
    }
    const known = new Set(runtime.revisionWarnings.map((item) => item.layer + '|' + item.path))
    const added = [...warnings].filter((item) => !known.has(item.layer + '|' + item.path))
    if (added.length === 0) {
      return
    }
    putRuntime({ ...runtime, revisionWarnings: [...runtime.revisionWarnings, ...added] })
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
        chainVerified: outcome.chainVerified,
        collectionId: outcome.collectionId,
        // 来源不可达时无从识别模型，按未确认处理
        model: 'unknown',
        plugins: [],
        fetchedAt: null,
        catalogVerified: false,
        revisionWarnings: [],
        skipped: 0,
        error: 'pluginMarketSourceFailed',
      })
    }
    const baseUrl = outcome.baseUrl
    const eec = await resolveCollectionEec(net, baseUrl, outcome.eec, outcome.collectionId)
    const rootCa = embeddedRootCa()
    // 先按特征文件识别来源模型：合集优先，整站作为第二模型，两者都不成立时按未确认处理
    const probe = await detectSourceModel(baseUrl, manifestReader, eec)
    const model: SourceModel = probe.model
    const layerContext: LayerContext = {
      net,
      baseUrl,
      eec,
      rootCa,
      memory: revisionMemory,
      layers: new Map(),
      warnings: new Map(),
    }
    const verifier =
      model === 'collection'
        ? createCollectionVerifier(layerContext)
        : model === 'site' && probe.site !== null
          ? createSiteVerifier(baseUrl, probe.site, eec, rootCa)
          : unverifiedVerifier
    // 先验根目录材料（合集的 L1 清单、整站的 web_files.json），再用它校验本次消费的目录文件；
    // 材料缺失或验签失败只降级为未校验，不阻断浏览与安装
    const l1 = await verifier.open('')
    const metaOk = await verifier.matches(
      l1,
      'meta.json',
      outcome.metaText === null ? null : textBytes(outcome.metaText)
    )
    const pluginsOk = await verifier.matches(l1, 'plugins.json', probe.plugins)
    const context: CatalogContext = {
      net,
      baseUrl,
      verifier,
      catalogVerified: l1.verified && metaOk && pluginsOk,
      l1Revision: l1.revision,
    }
    let plugins: CatalogPlugin[] = []
    let skipped = 0
    let error: TranslationKey | null = null
    if (probe.plugins === null) {
      error = 'pluginMarketCatalogFailed'
    } else {
      const index = parsePluginsIndex(bytesText(probe.plugins))
      if (!index) {
        error = 'pluginMarketCatalogFailed'
      } else {
        const loaded = await loadCatalog(context, index.entries)
        plugins = loaded.plugins
        skipped = index.skipped + loaded.skipped
      }
    }
    for (const plugin of plugins) {
      conclusionsCache.set(
        joinUrl(baseUrl, 'plugins/' + plugin.author + '/' + plugin.name + '/'),
        plugin.conclusions
      )
    }
    return putRuntime({
      id: source.id,
      state: 'ready',
      baseUrl,
      trust: outcome.trust,
      trustFailure: outcome.trustFailure,
      meta: outcome.meta,
      eec: outcome.eec,
      eecFromTrustList: outcome.eecFromTrustList,
      chainVerified: outcome.chainVerified,
      collectionId: outcome.collectionId,
      model,
      plugins,
      fetchedAt: Date.now(),
      catalogVerified: context.catalogVerified,
      // revision 回退提示只属于合集的三层清单，整站与未确认模型没有清单可取
      revisionWarnings: model === 'collection' ? [...layerContext.warnings.values()] : [],
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

  /** 更新检查的 versions.json 缓存；按插件目录缓存，避免同一插件的多次检查重复请求 */
  const updateCache = new Map<string, { latest: string; at: number }>()

  /**
   * 取插件目录下的最新版本号；失败或结构不符返回 null，由调用方按无法判断处理。
   * 检查更新同样先取该插件目录的校验材料，用它校验 versions.json；材料缺失时降级为未校验，
   * revision 回退只给提示，不改变更新判定。
   * 来源尚未刷新时按合集口径尝试（模型未知），已识别为整站模型时改按逐文件签名校验。
   */
  const latestOf = async (location: InstalledLocation): Promise<string | null> => {
    const key = location.pluginDir
    const cached = updateCache.get(key)
    if (cached && Date.now() - cached.at < CACHE_TTL) {
      return cached.latest
    }
    const owner = sourceList.find((source) =>
      source.baseUrls.some((baseUrl) => key.startsWith(baseUrl))
    )
    const runtime = owner ? (runtimes.get(owner.id) ?? null) : null
    // 同址来源已知合集 id 时直接用；未知时按来源名归一化，仍取不到时只试旧布局
    const collectionId = runtime?.collectionId ?? (owner ? normalizeCollectionId(owner.name) : '')
    const eec = await resolveCollectionEec(net, location.root, runtime?.eec ?? null, collectionId)
    const rootCa = embeddedRootCa()
    const layerContext: LayerContext = {
      net,
      baseUrl: location.root,
      eec,
      rootCa,
      memory: revisionMemory,
      layers: new Map(),
      warnings: new Map(),
    }
    let verifier: CatalogVerifier = createCollectionVerifier(layerContext)
    if (runtime?.model === 'site' && rootCa !== '') {
      const site = await fetchSiteManifest(location.root, manifestReader)
      if (site.manifest !== null) {
        verifier = createSiteVerifier(location.root, site, eec, rootCa)
      }
    }
    const layerPath = location.pluginDir.startsWith(location.root)
      ? location.pluginDir.slice(location.root.length)
      : ''
    const l3 = layerPath === '' ? null : await verifier.open(layerPath)
    const text = await requestText(net, versionsUrlOf(location))
    const list = text === null ? null : parseVersions(text)
    recordRevisionWarnings(location.root, layerContext.warnings.values())
    if (!list) {
      return null
    }
    if (l3 !== null) {
      conclusionsCache.set(location.pluginDir, {
        catalogVerified: runtime?.catalogVerified ?? false,
        metaVerified:
          l3.verified &&
          (await verifier.matches(l3, 'versions.json', text === null ? null : textBytes(text))),
        revisions: revisionsOf(null, null, l3.revision),
      })
    }
    updateCache.set(key, { latest: list.latest, at: Date.now() })
    return list.latest
  }

  /**
   * 检查已安装插件的版本更新。
   * 数据基址优先取记录里的 dataBase，缺失时由 source_url 推导出版本目录；
   * 请求沿用 1 秒超时，并发上限 4，失败静默，无法判断的插件不出现在结果里。
   */
  const checkUpdates = async (targets: readonly UpdateTarget[]): Promise<UpdateReport> => {
    const report: UpdateReport = new Map()
    const jobs = targets.filter((target) => target.id !== '' && VERSION_PATTERN.test(target.version))
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < jobs.length) {
        const target = jobs[cursor]
        cursor += 1
        const dataBase = dataBaseOf(target)
        const location = dataBase === null ? null : locateInstalled(dataBase)
        if (!location) {
          continue
        }
        const latest = await latestOf(location)
        if (latest === null) {
          continue
        }
        const status = updateStatusOf(target.version, latest)
        if (status === null) {
          continue
        }
        report.set(target.id, { status, latest })
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()))
    return report
  }

  /**
   * 生成重新安装计划：材料地址全部按已安装记录的地址推导，来源与信任结论沿用同址来源。
   * 地址结构不符时返回 null，界面据此提示无法更新。
   */
  const reinstallPlan = (target: UpdateTarget, version: string): ReinstallPlan | null => {
    const dataBase = dataBaseOf(target)
    const location = dataBase === null ? null : locateInstalled(dataBase)
    if (!location) {
      return null
    }
    const versionDir = versionDirOf(location, version)
    const paths = reinstallPathsOf(location, version)
    if (!versionDir || !paths) {
      return null
    }
    // 同址来源沿用它的信任清单判定：清单已登记时优先用清单证书，证书地址按来源根目录推导
    const owner = sourceList.find((source) =>
      source.baseUrls.some((baseUrl) => location.pluginDir.startsWith(baseUrl))
    )
    const runtime = owner ? (runtimes.get(owner.id) ?? null) : null
    // 合集 id 取自运行态；来源尚未刷新时按来源名归一化
    const collectionId = runtime?.collectionId ?? (owner ? normalizeCollectionId(owner.name) : '')
    // 目录结论来自本次拉取时的三层清单；没有缓存时按未校验处理
    const conclusions = conclusionsCache.get(location.pluginDir)
    const plan: InstallPlan = {
      url: paths.url,
      dataBase: versionDir,
      pluginBase: location.pluginDir,
      sourceType: owner ? sourceTypeOf(owner.id) : 'outer',
      sigUrl: paths.sigUrl,
      authorPubUrl: paths.authorPubUrl,
      authorSigUrl: paths.authorSigUrl,
      // 来源根目录下的合集证书：嵌套的 certs/<合集 id>/<合集 id>-eec.crt 优先，旧站点的扁平路径
      // certs/<合集 id>-eec.crt 兼容，最旧的 eec.pem 兜底；引擎取到后先做链校验
      eecUrls: collectionCertPaths(collectionId).map((path) => joinUrl(location.root, path)),
      ...(conclusions ?? { catalogVerified: false, metaVerified: false, revisions: {} }),
    }
    // 与市场安装同一口径：清单已登记时优先用清单证书，两种证书都要过链校验
    if (runtime?.eec) {
      plan.eec = runtime.eec
    }
    return {
      plan,
      trust: runtime?.trust ?? null,
      trustFailure: runtime?.trustFailure ?? null,
    }
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
      const pluginPath = 'plugins/' + plugin.author + '/' + plugin.name + '/'
      const versionPath = pluginPath + plugin.latest + '/'
      const baseUrl = runtime.baseUrl
      const eecUrls = collectionCertPaths(runtime.collectionId).map((path) =>
        joinUrl(baseUrl, path)
      )
      // 目录结论原样交给引擎：L1 覆盖目录数据，L3 覆盖该版本 meta.json，L2 给出作者公钥哈希
      const plan: InstallPlan = {
        ...plugin.conclusions,
        url: joinUrl(baseUrl, versionPath + 'plugin.js'),
        // 数据基址随安装交给引擎入库,后续检查更新直接请求,不必再从 plugins.json 反查
        dataBase: joinUrl(baseUrl, versionPath),
        pluginBase: joinUrl(baseUrl, pluginPath),
        sourceType: sourceTypeOf(id),
        sigUrl: joinUrl(baseUrl, versionPath + 'plugin.js.sig'),
        // 作者公钥放在作者目录，与合集分发结构 plugins/<作者>/author_pub.pem 一致
        authorPubUrl: joinUrl(baseUrl, 'plugins/' + plugin.author + '/author_pub.pem'),
        authorSigUrl: joinUrl(baseUrl, versionPath + 'plugin.js.author.sig'),
        // 来源自带的合集证书：嵌套的 certs/<合集 id>/<合集 id>-eec.crt 优先，旧站点的扁平路径
        // certs/<合集 id>-eec.crt 兼容，最旧的 eec.pem 兜底；引擎取到后先做链校验
        eecUrls,
      }
      // 清单已登记该来源的证书时优先用它，省一次请求；两种证书都要过链校验
      if (runtime.eec !== null) {
        plan.eec = runtime.eec
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
    checkUpdates,
    reinstallPlan,
    // 已移除插件判定只读各来源的清单，不写任何状态；来源配置变化后自动按新地址请求
    checkRemoved: (url) =>
      checkRemoved(net, sourceList.flatMap((source) => source.baseUrls), url),
  }
}
