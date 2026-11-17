import type { TranslationKey } from '../../i18n/index.js'
import { readManifest } from '../dsc-plugin-engine/registry.js'
import type { NetCapability, StorageCapability } from '../dsc-plugin-engine/types.js'
import type { MarketEntry, MarketState, MarketStatus } from './types.js'

/** 默认索引地址；站点上线前拉取必然失败，按降级路径处理 */
export const DEFAULT_INDEX_URL = 'https://omdsc-dev.github.io/awesome-dsc-plugin/index.json'
/** 缓存有效期（毫秒） */
const CACHE_TTL = 6 * 60 * 60 * 1000
/** 支持的索引结构版本 */
const SCHEMA_VERSION = 1
/** plugins:storage 中保存索引地址的键 */
const KEY_INDEX_URL = 'index-url'
/** plugins:storage 中保存索引缓存的键 */
const KEY_CACHE = 'index-cache'

/** 索引缓存 */
type CacheRecord = {
  fetchedAt: number
  entries: MarketEntry[]
  skipped: number
}

/** 解析后的索引 */
type ParsedIndex = {
  entries: MarketEntry[]
  skipped: number
}

/** 对外查询接口 */
export type MarketClient = {
  list(keyword?: string): MarketEntry[]
  get(id: string): MarketEntry | null
  refresh(force?: boolean): Promise<MarketStatus>
  status(): MarketStatus
  url(): string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFilled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

const isText = (value: unknown): value is string => typeof value === 'string'

/** 校验单条索引；缺字段或类型不符返回 null */
const parseEntry = (value: unknown): MarketEntry | null => {
  if (!isRecord(value)) {
    return null
  }
  const { id, name, version, description, author, homepage, download } = value
  if (!isFilled(id) || !isFilled(name) || !isFilled(version)) {
    return null
  }
  // download 为空时 new URL('') 会解析成页面自身，安装必然失败，按不合格条目跳过
  if (!isText(description) || !isText(author) || !isText(homepage) || !isFilled(download)) {
    return null
  }
  const entry: MarketEntry = { id, name, version, description, author, homepage, download }
  const manifest = readManifest(value.manifest)
  if (manifest) {
    entry.manifest = manifest
  }
  return entry
}

/** 校验索引整体结构；不合格条目跳过并计数，不整体失败 */
const parseIndex = (text: string): ParsedIndex | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    return null
  }
  const plugins = parsed.plugins
  if (!Array.isArray(plugins)) {
    return null
  }
  const entries: MarketEntry[] = []
  let skipped = 0
  const seen = new Set<string>()
  for (const item of plugins) {
    const entry = parseEntry(item)
    // 重复 id 会渲染出重复的 React key 与同 id 的两行，按不合格条目跳过
    if (!entry || seen.has(entry.id)) {
      skipped += 1
      continue
    }
    seen.add(entry.id)
    entries.push(entry)
  }
  return { entries, skipped }
}

const readCache = (storage: StorageCapability): CacheRecord | null => {
  let raw: unknown
  try {
    raw = storage.get(KEY_CACHE)
  } catch {
    return null
  }
  if (!isRecord(raw)) {
    return null
  }
  const { fetchedAt, entries, skipped } = raw
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt) || !Array.isArray(entries)) {
    return null
  }
  const valid: MarketEntry[] = []
  for (const item of entries) {
    const entry = parseEntry(item)
    if (entry) {
      valid.push(entry)
    }
  }
  return {
    fetchedAt,
    entries: valid,
    skipped: typeof skipped === 'number' ? skipped : 0,
  }
}

/** 创建索引客户端；所有失败都收敛成状态，不抛到宿主界面 */
export const createMarketClient = (
  net: NetCapability,
  storage: StorageCapability
): MarketClient => {
  let entries: MarketEntry[] = []
  let skipped = 0
  let fetchedAt: number | null = null
  let state: MarketState = 'idle'
  let error: TranslationKey | null = null
  let pending: Promise<MarketStatus> | null = null

  const snapshot = (): MarketStatus => ({
    state,
    fetchedAt,
    total: entries.length,
    skipped,
    error,
  })

  /** 索引地址可在 plugins:storage 中改写；只接受 https */
  const readUrl = (): string => {
    try {
      const stored = storage.get(KEY_INDEX_URL)
      if (isRecord(stored) && typeof stored.url === 'string' && stored.url.startsWith('https://')) {
        return stored.url
      }
    } catch {
      // 读取失败时退回默认地址
    }
    return DEFAULT_INDEX_URL
  }

  const settleWithCache = (cache: CacheRecord, reason: TranslationKey): MarketStatus => {
    entries = cache.entries
    skipped = cache.skipped
    fetchedAt = cache.fetchedAt
    state = 'stale'
    error = reason
    return snapshot()
  }

  const settleEmpty = (reason: TranslationKey): MarketStatus => {
    entries = []
    skipped = 0
    fetchedAt = null
    state = 'stale'
    error = reason
    return snapshot()
  }

  const run = async (force: boolean): Promise<MarketStatus> => {
    const cache = readCache(storage)
    if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL) {
      entries = cache.entries
      skipped = cache.skipped
      fetchedAt = cache.fetchedAt
      state = 'ready'
      error = null
      return snapshot()
    }
    state = 'loading'
    error = null
    let text: string
    try {
      const response = await net.getText(readUrl())
      text = response.text
    } catch {
      return cache ? settleWithCache(cache, 'pluginIndexFetchFailed') : settleEmpty('pluginIndexFetchFailed')
    }
    const parsed = parseIndex(text)
    if (!parsed) {
      return cache ? settleWithCache(cache, 'pluginIndexInvalid') : settleEmpty('pluginIndexInvalid')
    }
    const stamp = Date.now()
    entries = parsed.entries
    skipped = parsed.skipped
    fetchedAt = stamp
    state = 'ready'
    error = null
    try {
      storage.set(KEY_CACHE, { fetchedAt: stamp, entries, skipped })
    } catch {
      // 缓存写入失败不影响本次结果
    }
    return snapshot()
  }

  const refresh = async (force = false): Promise<MarketStatus> => {
    if (pending) {
      return await pending
    }
    pending = run(force)
    try {
      return await pending
    } finally {
      pending = null
    }
  }

  return {
    list: (keyword) => {
      const term = keyword?.trim().toLowerCase() ?? ''
      if (term === '') {
        return [...entries]
      }
      return entries.filter(
        (entry) =>
          entry.id.toLowerCase().includes(term) ||
          entry.name.toLowerCase().includes(term) ||
          entry.description.toLowerCase().includes(term)
      )
    },
    get: (id) => entries.find((entry) => entry.id === id) ?? null,
    refresh,
    status: snapshot,
    url: readUrl,
  }
}
