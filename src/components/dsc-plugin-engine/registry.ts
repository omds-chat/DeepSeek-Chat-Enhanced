import { CORE_CAPABILITIES, type CoreCapabilityId } from '../dsc-core/index.js'
import {
  CONTRIBUTION_POINTS,
  type ContributionHandler,
  type ContributionPoint,
  type DscPlugin,
  type InstallRejection,
  type InstallResult,
  type PluginManifest,
  type PluginSource,
  type PluginSourceType,
  type PluginState,
  type SignatureState,
} from './types.js'

/** 单个插件的日志上限 */
const MAX_LOG = 100
/** 插件 id 规则 */
const ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/
/** 版本号规则；严格三段且无前导零，与运行时 meta schema 一致 */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
/** 版本范围规则 */
const RANGE_PATTERN = /^(\^|~|>=|<=|=)?(\d+\.\d+\.\d+)$/

/** 落盘用的来源元数据；宿主直接注册的插件没有这一层 */
export type PluginOrigin = {
  sourceType: PluginSourceType
  /** 在线插件的 plugin.js 地址；local 来源没有 */
  sourceUrl?: string
  /** 获取插件时拿到的公钥 PEM */
  pub?: string
  /** 插件 plugin.js 的签名 base64 */
  sign?: string
  /** 本地插件的代码文本；本地插件没有可重新拉取的地址，恢复时靠它重建模块 */
  code?: string
  installedAt: number
  /** 启动校验失败后置为 false；缺省视为可信 */
  trusted: boolean
}

/** 写入记录时附带的存储元数据 */
export type RecordOptions = {
  origin?: PluginOrigin | null
  signature?: SignatureState
}

/** 已安装插件的运行记录 */
export type PluginRecord = {
  manifest: PluginManifest
  /** 内置插件直接给实例；恢复失败的外部插件没有实例 */
  plugin: DscPlugin | null
  /** 恢复来源；宿主直接注册的插件为 null，不参与落盘 */
  source: PluginSource | null
  /** 存储元数据；宿主直接注册的插件为 null，不参与落盘 */
  origin: PluginOrigin | null
  /** 签名校验状态 */
  signature: SignatureState
  /** 用户期望的运行状态 */
  enabled: boolean
  state: PluginState
  error?: string
  contributions: Map<ContributionPoint, Set<ContributionHandler>>
  disposers: Set<() => void>
  logs: string[]
}

const records = new Map<string, PluginRecord>()

/** 内置插件 id 集合；net:fetch 只对这些插件可见 */
const builtinIds = new Set<string>()

/** 登记内置插件 id */
export const markBuiltinPlugin = (id: string) => {
  builtinIds.add(id)
}

/** 是否内置插件 */
export const isBuiltinPlugin = (id: string): boolean => builtinIds.has(id)

/** 三元版本号 */
export type Version = readonly [number, number, number]

/** 解析版本号 */
export const parseVersion = (value: string): Version | null => {
  const match = VERSION_PATTERN.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

const compareVersion = (left: Version, right: Version): number =>
  left[0] - right[0] || left[1] - right[1] || left[2] - right[2]

/** 版本范围匹配；只支持单一范围表达式 */
export const satisfiesRange = (range: string, version: string): boolean => {
  const trimmed = range.trim()
  const target = parseVersion(version)
  if (!target) {
    return false
  }
  if (trimmed === '' || trimmed === '*') {
    return true
  }
  const match = RANGE_PATTERN.exec(trimmed)
  if (!match) {
    return false
  }
  const bound = parseVersion(match[2])
  if (!bound) {
    return false
  }
  const delta = compareVersion(target, bound)
  switch (match[1]) {
    case '^':
      return target[0] === bound[0] && delta >= 0
    case '~':
      return target[0] === bound[0] && target[1] === bound[1] && delta >= 0
    case '>=':
      return delta >= 0
    case '<=':
      return delta <= 0
    default:
      return delta === 0
  }
}

const readStringArray = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) {
    return null
  }
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      return null
    }
    items.push(item)
  }
  return items
}

/**
 * 从持久化数据或插件索引里还原清单。
 * 这里只做形态收敛，字段合法性仍由 checkInstallable 统一判定。
 */
export const readManifest = (value: unknown): PluginManifest | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.version !== 'string') {
    return null
  }
  const capabilities = readStringArray(raw.capabilities)
  if (!capabilities) {
    return null
  }
  const manifest: PluginManifest = {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    capabilities: capabilities as CoreCapabilityId[],
  }
  if (typeof raw.engines === 'string') {
    manifest.engines = raw.engines
  }
  const dependencies = readStringArray(raw.dependencies)
  if (dependencies) {
    manifest.dependencies = dependencies
  }
  const conflicts = readStringArray(raw.conflicts)
  if (conflicts) {
    manifest.conflicts = conflicts
  }
  const contributions = readStringArray(raw.contributions)
  if (contributions) {
    manifest.contributions = contributions as ContributionPoint[]
  }
  return manifest
}

const validateManifest = (manifest: PluginManifest): InstallRejection | null => {
  const name = manifest.name.trim()
  if (!ID_PATTERN.test(manifest.id) || name === '' || !VERSION_PATTERN.test(manifest.version)) {
    return 'invalid-manifest'
  }
  if (new Set(manifest.capabilities).size !== manifest.capabilities.length) {
    return 'invalid-manifest'
  }
  for (const capability of manifest.capabilities) {
    if (!CORE_CAPABILITIES.includes(capability)) {
      return 'unknown-capability'
    }
    // net:fetch 只对内置插件可见，第三方声明时按未知能力处理
    if (capability === 'net:fetch' && !builtinIds.has(manifest.id)) {
      return 'unknown-capability'
    }
  }
  const contributions = manifest.contributions ?? []
  if (new Set(contributions).size !== contributions.length) {
    return 'invalid-manifest'
  }
  for (const point of contributions) {
    if (!CONTRIBUTION_POINTS.includes(point)) {
      return 'unknown-contribution'
    }
  }
  return null
}

/** 安装前校验：清单、重名、版本兼容、冲突与依赖 */
export const checkInstallable = (manifest: PluginManifest, coreVersion: string): InstallResult => {
  const problem = validateManifest(manifest)
  if (problem) {
    return { ok: false, reason: problem }
  }
  const existing = records.get(manifest.id)
  // 恢复失败的占位记录没有实例，允许重新安装覆盖
  if (existing && existing.plugin !== null) {
    return { ok: false, reason: 'duplicate' }
  }
  if (manifest.engines && !satisfiesRange(manifest.engines, coreVersion)) {
    return { ok: false, reason: 'incompatible-version', detail: manifest.engines }
  }
  for (const id of manifest.conflicts ?? []) {
    if (records.has(id)) {
      return { ok: false, reason: 'conflict', detail: id }
    }
  }
  for (const id of manifest.dependencies ?? []) {
    if (!records.has(id)) {
      return { ok: false, reason: 'missing-dependency', detail: id }
    }
  }
  return { ok: true }
}

/** 全部插件记录 */
export const all = (): PluginRecord[] => [...records.values()]

/** 按 id 取记录 */
export const get = (id: string): PluginRecord | undefined => records.get(id)

/** 写入记录 */
export const add = (
  manifest: PluginManifest,
  plugin: DscPlugin,
  source: PluginSource | null,
  options: RecordOptions = {}
): PluginRecord => {
  const record: PluginRecord = {
    manifest,
    plugin,
    source,
    origin: options.origin ?? null,
    signature: options.signature ?? 'unverified',
    enabled: false,
    state: 'registered',
    contributions: new Map(),
    disposers: new Set(),
    logs: [],
  }
  records.set(manifest.id, record)
  return record
}

/** 写入恢复失败的占位记录；没有实例，只在 list() 中可见 */
export const addFailed = (
  manifest: PluginManifest,
  source: PluginSource | null,
  reason: string,
  options: RecordOptions = {}
): PluginRecord => {
  const record: PluginRecord = {
    manifest,
    plugin: null,
    source,
    origin: options.origin ?? null,
    signature: options.signature ?? 'unverified',
    enabled: true,
    state: 'failed',
    error: reason,
    contributions: new Map(),
    disposers: new Set(),
    logs: [reason],
  }
  records.set(manifest.id, record)
  return record
}

/** 移除记录 */
export const remove = (id: string): boolean => records.delete(id)

/** 标记为已激活；同时记录用户期望启用 */
export const markActive = (record: PluginRecord) => {
  record.state = 'active'
  record.enabled = true
  record.error = undefined
}

/** 标记为已停用；同时记录用户期望停用 */
export const markInactive = (record: PluginRecord) => {
  record.state = 'inactive'
  record.enabled = false
}

/** 标记为失败；enabled 保持不变，避免一次失败抹掉用户意图 */
export const markFailed = (record: PluginRecord, reason: string) => {
  record.state = 'failed'
  record.error = reason
}

/** 清空贡献点 */
export const clearContributions = (record: PluginRecord) => {
  record.contributions.clear()
}

/** 追加日志；超出上限丢弃最早一条 */
export const pushLog = (record: PluginRecord, message: string) => {
  record.logs.push(message)
  if (record.logs.length > MAX_LOG) {
    record.logs.shift()
  }
}

/** 执行并清空释放函数 */
export const runDisposers = (record: PluginRecord) => {
  for (const disposer of record.disposers) {
    try {
      disposer()
    } catch (error) {
      pushLog(record, `disposer failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  record.disposers.clear()
}

/** 尚未激活的依赖 */
export const pendingDependencies = (record: PluginRecord): string[] =>
  (record.manifest.dependencies ?? []).filter((id) => records.get(id)?.state !== 'active')

/** 依赖该插件的已激活插件 */
export const activeDependents = (id: string): string[] =>
  all()
    .filter(
      (record) =>
        record.state === 'active' && (record.manifest.dependencies ?? []).includes(id)
    )
    .map((record) => record.manifest.id)
