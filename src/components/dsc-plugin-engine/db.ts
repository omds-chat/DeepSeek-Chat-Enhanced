import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { APP_NAME } from '../../brand.js'
import { readManifest } from './registry.js'
import { clearLegacyInstalled, readLegacyInstalled, type LegacyPlugin } from './storage.js'
import type { PluginManifest, PluginSourceType } from './types.js'

/** 独立数据库名，避免与聊天历史库冲突 */
const DB_NAME = `${APP_NAME}-plugins`
const DB_VERSION = 1
const STORE = 'plugins'

/** 合法的来源类型 */
const SOURCE_TYPES: readonly string[] = ['inner', 'awesome', 'outer', 'local']

/**
 * 一条安装记录。
 * source_url 只对在线分发的插件存在，只在检查更新时使用；eec 与 sig 是合集对 plugin.js 的证书与 CMS 签名，
 * author_pub 与 author_sig 是作者公钥与作者裸签名，缺省表示这条记录没有对应的签名材料。
 */
export type StoredPluginRecord = {
  id: string
  manifest: PluginManifest
  source_type: PluginSourceType
  source_url?: string
  /** 该版本目录的地址,形如 <base>/plugins/<作者>/<插件>/<版本>/ */
  data_base?: string
  /** 插件目录的地址,形如 <base>/plugins/<作者>/<插件>/ */
  plugin_base?: string
  /** 合集 EEC 证书 PEM */
  eec?: string
  /** plugin.js.sig 的 base64 */
  sig?: string
  /** 作者公钥 PEM */
  author_pub?: string
  /** 作者签名的 base64 */
  author_sig?: string
  /**
   * 插件代码文本。在线插件在安装时下载并保存,本地插件取离线包内的 plugin.js；
   * 启动恢复只用它重建 Blob 模块,不再为启动发起网络请求。
   */
  code?: string
  enabled: boolean
  installed_at: number
  /** 启动校验失败后置为 false；缺省视为可信 */
  trusted?: boolean
}

interface PluginDB extends DBSchema {
  plugins: { key: string; value: StoredPluginRecord }
}

/** 落盘结果；失败不抛错，由调用方记日志 */
export type SaveResult = { ok: true } | { ok: false; reason: string }

/** 读取结果；problem 描述读取与迁移过程中丢弃或降级的内容 */
export type LoadRecordsResult = { records: StoredPluginRecord[]; problem: string | null }

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readSourceType = (value: unknown): PluginSourceType | null =>
  typeof value === 'string' && SOURCE_TYPES.includes(value) ? (value as PluginSourceType) : null

const readOptionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** 收敛一条存储记录；字段不合法时返回 null，由调用方丢弃该条 */
const readStoredRecord = (value: unknown): StoredPluginRecord | null => {
  if (!isRecord(value)) {
    return null
  }
  const manifest = readManifest(value.manifest)
  const sourceType = readSourceType(value.source_type)
  if (!manifest || !sourceType) {
    return null
  }
  if (typeof value.id !== 'string' || value.id !== manifest.id) {
    return null
  }
  const record: StoredPluginRecord = {
    id: value.id,
    manifest,
    source_type: sourceType,
    enabled: value.enabled === true,
    installed_at: typeof value.installed_at === 'number' ? value.installed_at : 0,
  }
  const sourceUrl = readOptionalText(value.source_url)
  if (sourceUrl) {
    record.source_url = sourceUrl
  }
  const dataBase = readOptionalText(value.data_base)
  if (dataBase) {
    record.data_base = dataBase
  }
  const pluginBase = readOptionalText(value.plugin_base)
  if (pluginBase) {
    record.plugin_base = pluginBase
  }
  const eec = readOptionalText(value.eec)
  if (eec) {
    record.eec = eec
  }
  const sig = readOptionalText(value.sig)
  if (sig) {
    record.sig = sig
  }
  const authorPub = readOptionalText(value.author_pub)
  if (authorPub) {
    record.author_pub = authorPub
  }
  const authorSig = readOptionalText(value.author_sig)
  if (authorSig) {
    record.author_sig = authorSig
  }
  const code = readOptionalText(value.code)
  if (code) {
    record.code = code
  }
  if (value.trusted === false) {
    record.trusted = false
  }
  return record
}

/** IndexedDB 不可用时的内存镜像；只在本次页面生命周期内有效 */
const memory = new Map<string, StoredPluginRecord>()

/** 是否已降级到内存存储 */
let degraded = false

let dbPromise: Promise<IDBPDatabase<PluginDB> | null> | null = null

/** 打开插件库；不可用时返回 null，由调用方走内存存储 */
const openPluginDB = (): Promise<IDBPDatabase<PluginDB> | null> => {
  if (dbPromise) {
    return dbPromise
  }
  dbPromise = (async (): Promise<IDBPDatabase<PluginDB> | null> => {
    if (typeof indexedDB === 'undefined') {
      return null
    }
    try {
      return await openDB<PluginDB>(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id' })
          }
        },
      })
    } catch {
      return null
    }
  })().then((db) => {
    if (db === null) {
      degraded = true
      // 打开失败后允许后续调用重试，避免一直复用被拒绝的 Promise
      dbPromise = null
    }
    return db
  })
  return dbPromise
}

/** 插件存储是否已降级为内存存储 */
export const isPluginStorageDegraded = (): boolean => degraded

/** 读取全部安装记录；单条损坏只丢弃该条，IndexedDB 不可用时读内存镜像 */
export const readPluginRecords = async (): Promise<LoadRecordsResult> => {
  const db = await openPluginDB()
  if (!db) {
    return {
      records: [...memory.values()],
      problem: 'IndexedDB is not available; plugin records live in memory only',
    }
  }
  try {
    const rows = await db.getAll(STORE)
    const records: StoredPluginRecord[] = []
    let dropped = 0
    for (const row of rows) {
      const record = readStoredRecord(row)
      if (record) {
        records.push(record)
      } else {
        dropped += 1
      }
    }
    return { records, problem: dropped > 0 ? `${dropped} stored plugin records were dropped` : null }
  } catch (error) {
    degraded = true
    return { records: [...memory.values()], problem: `plugin store read failed: ${describe(error)}` }
  }
}

/** 整体覆盖安装记录；写入失败时同步镜像到内存，保证本次会话仍可读写 */
export const writePluginRecords = async (
  records: readonly StoredPluginRecord[]
): Promise<SaveResult> => {
  const mirror = () => {
    memory.clear()
    for (const record of records) {
      memory.set(record.id, record)
    }
  }
  const db = await openPluginDB()
  if (!db) {
    mirror()
    return { ok: true }
  }
  try {
    const tx = db.transaction(STORE, 'readwrite')
    // 先清空再写入，避免已卸载的记录残留
    const cleared = tx.store.clear()
    const writes = records.map((record) => tx.store.put(record))
    await Promise.all([cleared, ...writes, tx.done])
    return { ok: true }
  } catch (error) {
    degraded = true
    mirror()
    return { ok: false, reason: describe(error) }
  }
}

/**
 * 旧版记录转成新结构：内置来源记为 inner，url 来源记为 outer 并保留地址，
 * 迁移时拿不到证书与签名，eec、sig 与作者材料全部留空。
 */
export const convertLegacyPlugin = (entry: LegacyPlugin): StoredPluginRecord | null => {
  if (entry.source.kind === 'builtin') {
    return {
      id: entry.manifest.id,
      manifest: entry.manifest,
      source_type: 'inner',
      enabled: entry.enabled,
      installed_at: Date.now(),
    }
  }
  if (entry.source.kind === 'url' && entry.source.url !== '') {
    return {
      id: entry.manifest.id,
      manifest: entry.manifest,
      source_type: 'outer',
      source_url: entry.source.url,
      enabled: entry.enabled,
      installed_at: Date.now(),
    }
  }
  return null
}

let migrationDone = false

/** 把旧版 localStorage 记录迁移进 IndexedDB；只执行一次，失败不阻断启动 */
export const migrateLegacyPlugins = async (): Promise<string | null> => {
  if (migrationDone) {
    return null
  }
  migrationDone = true
  const legacy = readLegacyInstalled()
  if (!legacy.present) {
    return legacy.problem
  }
  const current = await readPluginRecords()
  const byId = new Map(current.records.map((record) => [record.id, record]))
  for (const entry of legacy.entries) {
    const converted = convertLegacyPlugin(entry)
    if (converted && !byId.has(converted.id)) {
      byId.set(converted.id, converted)
    }
  }
  const saved = await writePluginRecords([...byId.values()])
  if (!saved.ok) {
    // 写入失败时保留旧键，下次启动重试
    return `legacy plugin migration failed: ${saved.reason}`
  }
  const cleared = clearLegacyInstalled()
  const problems = [legacy.problem, cleared ? null : 'legacy plugin key was not cleared']
  const text = problems.filter((item): item is string => item !== null).join('; ')
  return text === '' ? null : text
}

/** 读取安装记录；先做一次旧版迁移，再返回全部记录 */
export const loadPluginRecords = async (): Promise<LoadRecordsResult> => {
  const migration = await migrateLegacyPlugins()
  const loaded = await readPluginRecords()
  const problems = [migration, loaded.problem].filter(
    (item): item is string => item !== null && item !== ''
  )
  return { records: loaded.records, problem: problems.length > 0 ? problems.join('; ') : null }
}
