import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { APP_NAME } from '../../brand.js'
import { isSourceId, normalizeSourceBaseUrl } from '../dsc-core/source-catalog.js'

/**
 * 供应端点凭证存储。
 * 凭证按「端点 id + 规范化后的端点基址」存放, 与安装记录分库: 安装记录的升级不牵连凭证, 反之亦然。
 * 基址参与键与比对的原因: 只按 id 存放时, 同名端点换到另一台主机后旧 Key 会被发到新主机;
 * 现在换基址等于查不到记录, 读取结论为 stale, 界面据此要求重新填写, 而不是复用旧 Key。
 * 本模块只被引擎的执行路径引用, 不从引擎门面再导出: 插件拿不到读写入口, 也拿不到任何凭证值。
 * 明文存放, 与既有设置里的 API Key 同一取舍: 客户端加密拿不到额外保护, 密钥只能来自同一页面。
 */

/** 独立数据库名 */
const DB_NAME = `${APP_NAME}-plugin-sources`
/** Schema 版本 2: 主键从单一 id 改为「id + 基址」, 键结构变化时整体重建仓库 */
const DB_VERSION = 2
const STORE = 'credentials'
const SOURCE_INDEX = 'by_source'

/** 一条供应端点凭证 */
export type SourceCredential = {
  readonly sourceId: string
  /** 规范化后的端点基址; 与记录绑定的端点 */
  readonly baseUrl: string
  readonly apiKey: string
  readonly updatedAt: number
}

/** 落盘形态; 键为 [source_id, base_url] */
type StoredCredential = {
  source_id: string
  base_url: string
  api_key: string
  updated_at: number
}

interface CredentialDB extends DBSchema {
  credentials: {
    key: [string, string]
    value: StoredCredential
    indexes: { by_source: string }
  }
}

/**
 * 读取结论。
 * ok 可直接使用; missing 没有该端点的记录; stale 同一端点 id 还存在别的基址的记录,
 * 说明端点换过主机, 旧凭证不能复用, 需要重新填写。
 */
export type CredentialStatus = 'ok' | 'missing' | 'stale'

/** 读取结果; 存储不可用时把原因写进 problem */
export type ReadCredentialResult = {
  readonly status: CredentialStatus
  readonly credential: SourceCredential | null
  readonly problem: string | null
}

/** 写入结果; 失败不抛错, 由调用方记日志 */
export type WriteCredentialResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** 内存镜像的键; 基址规范化后不会含有换行, 直接用换行分隔不会撞键 */
const mirrorKey = (sourceId: string, baseUrl: string): string => sourceId + '\n' + baseUrl

/** IndexedDB 不可用或读写失败时的内存镜像; 只在本页生命周期内有效 */
const memory = new Map<string, SourceCredential>()

let degraded = false

let dbPromise: Promise<IDBPDatabase<CredentialDB> | null> | null = null

/** 打开凭证库; 不可用时返回 null, 由调用方走内存镜像 */
const openCredentialDB = (): Promise<IDBPDatabase<CredentialDB> | null> => {
  if (dbPromise) {
    return dbPromise
  }
  dbPromise = (async (): Promise<IDBPDatabase<CredentialDB> | null> => {
    if (typeof indexedDB === 'undefined') {
      return null
    }
    try {
      return await openDB<CredentialDB>(DB_NAME, DB_VERSION, {
        upgrade(db, oldVersion) {
          // 旧版按单一 id 存放, 无法判断记录属于哪个基址, 直接丢弃, 由用户重新填写
          if (oldVersion < 2 && db.objectStoreNames.contains(STORE)) {
            db.deleteObjectStore(STORE)
          }
          const store = db.createObjectStore(STORE, { keyPath: ['source_id', 'base_url'] })
          store.createIndex(SOURCE_INDEX, 'source_id')
        },
      })
    } catch {
      return null
    }
  })().then((db) => {
    if (db === null) {
      degraded = true
      // 打开失败后允许后续调用重试, 避免一直复用被拒绝的 Promise
      dbPromise = null
    }
    return db
  })
  return dbPromise
}

/** 凭证存储是否已降级为内存镜像 */
export const isCredentialStorageDegraded = (): boolean => degraded

/** 存储记录收敛成凭证; 字段不合法时返回 null */
const readStored = (value: unknown): SourceCredential | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const raw = value as Record<string, unknown>
  if (
    !isSourceId(raw.source_id) ||
    typeof raw.base_url !== 'string' ||
    typeof raw.api_key !== 'string' ||
    raw.api_key === ''
  ) {
    return null
  }
  return {
    sourceId: raw.source_id,
    baseUrl: raw.base_url,
    apiKey: raw.api_key,
    updatedAt: typeof raw.updated_at === 'number' ? raw.updated_at : 0,
  }
}

/** 内存镜像里同一端点 id 是否还有别的基址; 用于区分 missing 与 stale */
const mirrorHasOtherBase = (sourceId: string, baseUrl: string): boolean => {
  for (const credential of memory.values()) {
    if (credential.sourceId === sourceId && credential.baseUrl !== baseUrl) {
      return true
    }
  }
  return false
}

const readFromMemory = (
  sourceId: string,
  baseUrl: string,
  problem: string | null
): ReadCredentialResult => {
  const credential = memory.get(mirrorKey(sourceId, baseUrl)) ?? null
  if (credential) {
    return { status: 'ok', credential, problem }
  }
  return {
    status: mirrorHasOtherBase(sourceId, baseUrl) ? 'stale' : 'missing',
    credential: null,
    problem,
  }
}

/**
 * 读取某个端点基址对应的凭证。
 * 基址先规范化再比对; 记录不存在时区分 missing 与 stale, 后者表示端点换过主机、需要重新填写。
 */
export const readSourceCredential = async (
  sourceId: string,
  baseUrl: string
): Promise<ReadCredentialResult> => {
  const normalized = normalizeSourceBaseUrl(baseUrl)
  if (!isSourceId(sourceId) || normalized === null) {
    return { status: 'missing', credential: null, problem: 'source id or base url is invalid' }
  }
  const db = await openCredentialDB()
  if (!db) {
    return readFromMemory(
      sourceId,
      normalized,
      'IndexedDB is not available; source credentials live in memory only'
    )
  }
  try {
    const record = readStored(await db.get(STORE, [sourceId, normalized]))
    if (record) {
      return { status: 'ok', credential: record, problem: null }
    }
    const others = await db.getAllFromIndex(STORE, SOURCE_INDEX, sourceId)
    const stale = others.some((row) => readStored(row)?.baseUrl !== normalized)
    return { status: stale ? 'stale' : 'missing', credential: null, problem: null }
  } catch (error) {
    degraded = true
    return readFromMemory(sourceId, normalized, `source credential read failed: ${describe(error)}`)
  }
}

/**
 * 写入某个端点基址的凭证。
 * 写入前校验端点 id、基址与 API Key 形态, 空值不落盘; 基址换过时新记录与旧记录并存,
 * 旧记录不再被读到, 因此不会把旧 Key 发到新主机。
 */
export const writeSourceCredential = async (
  sourceId: string,
  baseUrl: string,
  apiKey: string
): Promise<WriteCredentialResult> => {
  const normalized = normalizeSourceBaseUrl(baseUrl)
  if (!isSourceId(sourceId) || normalized === null) {
    return { ok: false, reason: 'source id or base url is invalid' }
  }
  const trimmed = apiKey.trim()
  if (trimmed === '') {
    return { ok: false, reason: 'api key is empty' }
  }
  const credential: SourceCredential = {
    sourceId,
    baseUrl: normalized,
    apiKey: trimmed,
    updatedAt: Date.now(),
  }
  memory.set(mirrorKey(sourceId, normalized), credential)
  const db = await openCredentialDB()
  if (!db) {
    return { ok: true }
  }
  try {
    await db.put(STORE, {
      source_id: credential.sourceId,
      base_url: credential.baseUrl,
      api_key: credential.apiKey,
      updated_at: credential.updatedAt,
    })
    return { ok: true }
  } catch (error) {
    degraded = true
    return { ok: false, reason: describe(error) }
  }
}
