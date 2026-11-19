import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import { pluginReasonText } from '../../i18n/pluginReasons.js'
import { showToast } from '../base/toastState.js'
import {
  CORE_VERSION,
  createCredential,
  hasPluginData,
  issueTicket,
  openCore,
  readBypassEvents,
  setAlertSink,
  type BypassEvent,
  type CoreApi,
  type CoreCredential,
  type CoreEvent,
} from '../dsc-core/index.js'
import { BUILTIN_PLUGIN_IDS, BUILTIN_PLUGINS } from './builtin.js'
import { createPluginContext, runWithTimeout } from './capabilities.js'
import { loadPluginRecords, writePluginRecords, type StoredPluginRecord } from './db.js'
import {
  decodePluginCode,
  inspectPackageFiles,
  readLocalPackage,
  toPluginId,
  type PackageInspection,
} from './localPackage.js'
import { isPluginSourceAllowed, loadPluginModuleFromCode, resolvePluginModule } from './loader.js'
import * as store from './registry.js'
import {
  decodeSignature,
  encodeSignature,
  fetchArtifactBytes,
  hasSignatureMaterial,
  loadSignatureMaterial,
  sourceVerdictOf,
  verifyArtifact,
  type ChainState,
  type SignatureMaterial,
  type SignatureSource,
} from './signature.js'
import { MAX_PLUGIN_CODE_BYTES } from './types.js'
import type {
  DscPlugin,
  InstallResult,
  LoadedPlugin,
  LocalPackageInfo,
  LocalPackageInspection,
  PluginManifest,
  PluginSource,
  PluginSourceType,
  PluginStateView,
  SignatureState,
  SourceTrustFailure,
  SourceTrustState,
  SourceVerdict,
} from './types.js'

/** 激活与停用的时间上限（毫秒） */
const ACTIVATE_TIMEOUT = 5000
const DEACTIVATE_TIMEOUT = 3000
/** 引擎自身日志上限 */
const MAX_ENGINE_LOG = 100

/**
 * 安装时携带的来源信息。
 * eec 与 eecUrl 都提供合集证书：两者都有时优先用信任清单登记的 eec，省一次请求；
 * 证书必须在本机通过证书链校验才会用于 CMS 验签，链不通过时结论为 failed 且不再验签。
 * authorPubUrl 与 authorSigUrl 齐全时做作者裸签名验签；没有证书时 CMS 验签直接跳过。
 */
export type InstallSource = SignatureSource & {
  sourceType: PluginSourceType
  /** 该版本目录的地址,形如 <base>/plugins/<作者>/<插件>/<版本>/；缺省由 url 推导 */
  dataBase?: string
  /** 插件目录的地址,形如 <base>/plugins/<作者>/<插件>/；缺省由 dataBase 推导 */
  pluginBase?: string
  /** 来源信任判定；缺省按未登记处理 */
  trust?: SourceTrustState
  /** 信任清单给出的失败原因；revoked 表示合集 EEC 证书已被吊销 */
  trustFailure?: SourceTrustFailure
}

/**
 * 把目录地址收敛成以斜杠结尾的形式；能按 URL 解析时用 URL 规范化,否则只补斜杠。
 * 空串与缺省返回 null,由调用方回退推导。
 */
const normalizeDirectoryUrl = (value: string | undefined): string | null => {
  if (value === undefined) {
    return null
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    return null
  }
  try {
    const target = new URL(trimmed)
    return target.href.endsWith('/') ? target.href : target.href + '/'
  } catch {
    return trimmed.endsWith('/') ? trimmed : trimmed + '/'
  }
}

/**
 * 由产物地址推导版本目录地址：去掉最后一段文件名。
 * 插件市场的产物地址形如 <base>/plugins/<作者>/<插件>/<版本>/plugin.js。
 */
export const deriveDataBase = (url: string): string => {
  try {
    const target = new URL(url)
    target.search = ''
    target.hash = ''
    const segments = target.pathname.split('/')
    segments.pop()
    target.pathname = segments.join('/') + '/'
    return target.href
  } catch {
    const cut = url.lastIndexOf('/')
    return cut >= 0 ? url.slice(0, cut + 1) : url + '/'
  }
}

/** 由版本目录地址推导插件目录地址：去掉最后一段版本号 */
export const derivePluginBase = (dataBase: string): string => {
  const trimmed = dataBase.endsWith('/') ? dataBase.slice(0, -1) : dataBase
  return deriveDataBase(trimmed)
}

/**
 * 卸载结论。
 * removed 表示注册表记录与持久化记录是否已移除；hasLeftoverData 表示该插件是否还留有本地数据，
 * 卸载默认保留这些数据，供插件回归后做旧数据迁移。
 */
export type UnloadResult = {
  removed: boolean
  hasLeftoverData: boolean
}

/** 插件引擎对外接口 */
export type PluginEngine = {
  readonly version: string
  install(manifest: PluginManifest, plugin: DscPlugin): InstallResult
  /**
   * 运行时安装；manifest 缺省时使用产物自带的 manifest 导出。
   * source 缺省按 outer 处理且不校验签名；带签名材料时先校验产物签名。
   */
  installFromUrl(
    url: string,
    manifest?: PluginManifest,
    source?: InstallSource
  ): Promise<InstallResult>
  /**
   * 本地离线包预检：解包、校验清单与签名，返回待安装信息与提交函数。
   * 不改动任何状态；二次确认在界面层完成，确认后才调用返回的提交函数。
   */
  inspectLocalPackage(file: File): Promise<LocalPackageInspection>
  /** 从本地离线包安装：预检通过后直接提交，不包含界面确认 */
  installFromLocalFile(file: File): Promise<InstallResult>
  activate(id: string): Promise<boolean>
  deactivate(id: string): Promise<boolean>
  unload(id: string): Promise<UnloadResult>
  list(): PluginStateView[]
  logs(id: string): readonly string[]
  /** 引擎自身的日志，例如落盘与恢复失败 */
  engineLogs(): readonly string[]
  bypassEvents(): readonly BypassEvent[]
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

let engine: PluginEngine | null = null

/** 安装并启动插件引擎；重复调用返回同一实例 */
export const installPluginEngine = (): PluginEngine => {
  if (engine) {
    return engine
  }
  const credential: CoreCredential = createCredential('dsc-plugin-engine')
  const core: CoreApi = openCore(credential)
  const report = (key: TranslationKey, params?: TranslationParams) => {
    showToast({ type: 'error', key, params })
  }
  /** 签名类问题只提示，不阻断：不带错误图标，语义是警告 */
  const warn = (key: TranslationKey, params?: TranslationParams) => {
    showToast({ key, params })
  }
  setAlertSink((message) => report(message.key, message.params))

  const engineLogs: string[] = []
  const pushEngineLog = (message: string) => {
    engineLogs.push(message)
    if (engineLogs.length > MAX_ENGINE_LOG) {
      engineLogs.shift()
    }
  }

  /** 恢复期间不落盘，避免用尚未恢复完的注册表覆盖已有记录 */
  let restoring = true

  /** 注册表记录转成存储记录；宿主直接注册的插件没有来源，不参与落盘 */
  const toStored = (record: store.PluginRecord): StoredPluginRecord | null => {
    const origin = record.origin
    if (!origin) {
      return null
    }
    const stored: StoredPluginRecord = {
      id: record.manifest.id,
      manifest: record.manifest,
      source_type: origin.sourceType,
      enabled: record.enabled,
      installed_at: origin.installedAt,
    }
    if (origin.sourceUrl) {
      stored.source_url = origin.sourceUrl
    }
    if (origin.dataBase) {
      stored.data_base = origin.dataBase
    }
    if (origin.pluginBase) {
      stored.plugin_base = origin.pluginBase
    }
    if (origin.eec) {
      stored.eec = origin.eec
    }
    if (origin.eecAnchored) {
      stored.eec_anchored = true
    }
    if (origin.sourceTrust) {
      stored.source_trust = origin.sourceTrust
    }
    if (origin.trustFailure) {
      stored.trust_failure = origin.trustFailure
    }
    if (origin.sig) {
      stored.sig = origin.sig
    }
    if (origin.authorPub) {
      stored.author_pub = origin.authorPub
    }
    if (origin.authorSig) {
      stored.author_sig = origin.authorSig
    }
    if (origin.code) {
      stored.code = origin.code
    }
    if (!origin.trusted) {
      stored.trusted = false
    }
    return stored
  }

  /** 把当前注册表落盘；失败只记日志，不影响内存状态 */
  const persist = (): void => {
    if (restoring) {
      return
    }
    const records: StoredPluginRecord[] = []
    for (const record of store.all()) {
      const stored = toStored(record)
      if (stored) {
        records.push(stored)
      }
    }
    void writePluginRecords(records).then((result) => {
      if (!result.ok) {
        pushEngineLog(`persist failed: ${result.reason}`)
      }
    })
  }

  /** 把核心事件分发给声明了贡献点的插件；单个插件出错不影响其他插件 */
  const dispatch = (event: CoreEvent): void => {
    for (const record of store.all()) {
      if (record.state !== 'active') {
        continue
      }
      const handlers = record.contributions.get(event.type)
      if (!handlers) {
        continue
      }
      for (const handler of [...handlers]) {
        try {
          const result: unknown = handler(event)
          if (result instanceof Promise) {
            void result.catch((error: unknown) => {
              store.pushLog(record, describeError(error))
            })
          }
        } catch (error) {
          store.pushLog(record, describeError(error))
        }
      }
    }
  }

  const register = (
    manifest: PluginManifest,
    plugin: DscPlugin,
    source: PluginSource | null,
    options: store.RecordOptions = {}
  ): InstallResult => {
    const check = store.checkInstallable(manifest, CORE_VERSION)
    if (!check.ok) {
      // 拒绝原因转成可读文案；原始代码留在 check.reason 与插件日志里
      report('pluginInstallRejected', {
        id: manifest.id,
        reason: pluginReasonText(check.reason, check.detail),
      })
      return check
    }
    store.add(manifest, plugin, source, options)
    return { ok: true }
  }

  const install = (manifest: PluginManifest, plugin: DscPlugin): InstallResult =>
    register(manifest, plugin, null)

  /**
   * 同一插件的生命周期操作串行执行。
   * 并发激活会让同一个插件实例执行两遍 activate，事件处理器与释放函数重复登记；
   * 激活与卸载交错时，卸载会先移除记录，随后的 activate 仍把已消失的记录标记为 active。
   */
  const queues = new Map<string, Promise<unknown>>()
  const serialize = <T>(id: string, task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(id) ?? Promise.resolve()
    const current = previous.then(task, task)
    const settled = current.catch(() => undefined)
    queues.set(id, settled)
    void settled.then(() => {
      if (queues.get(id) === settled) {
        queues.delete(id)
      }
    })
    return current
  }

  const activateNow = async (id: string): Promise<boolean> => {
    const record = store.get(id)
    if (!record) {
      return false
    }
    if (record.state === 'active') {
      return true
    }
    if (!record.plugin) {
      report('pluginRestoreFailed', {
        id,
        reason: pluginReasonText(record.error ?? 'no-plugin-instance'),
      })
      return false
    }
    const pending = store.pendingDependencies(record)
    if (pending.length > 0) {
      store.markFailed(record, `missing-dependency:${pending.join(',')}`)
      report('pluginActivateFailed', {
        id,
        reason: pluginReasonText(`missing-dependency:${pending[0]}`),
      })
      persist()
      return false
    }
    try {
      const context = createPluginContext({ record, core, credential, report })
      await runWithTimeout(Promise.resolve(record.plugin.activate(context)), ACTIVATE_TIMEOUT, {
        onTimeout: () => report('pluginCallTimeout', { id, capability: 'activate' }),
      })
      store.markActive(record)
      persist()
      return true
    } catch (error) {
      // 激活中途失败时同样要撤销已注册的处理器，避免残留订阅
      store.clearContributions(record)
      store.runDisposers(record)
      store.markFailed(record, describeError(error))
      // 原始错误只进插件日志，界面用可读文案
      store.pushLog(record, describeError(error))
      report('pluginActivateFailed', { id, reason: pluginReasonText(describeError(error)) })
      persist()
      return false
    }
  }

  const deactivateNow = async (id: string): Promise<boolean> => {
    const record = store.get(id)
    if (!record || record.state !== 'active' || !record.plugin) {
      return false
    }
    try {
      if (record.plugin.deactivate) {
        await runWithTimeout(Promise.resolve(record.plugin.deactivate()), DEACTIVATE_TIMEOUT, {
          onTimeout: () => report('pluginCallTimeout', { id, capability: 'deactivate' }),
        })
      }
    } catch (error) {
      store.pushLog(record, describeError(error))
    } finally {
      store.clearContributions(record)
      store.runDisposers(record)
      store.markInactive(record)
    }
    persist()
    return true
  }

  const unloadNow = async (id: string): Promise<UnloadResult> => {
    const record = store.get(id)
    if (!record) {
      return { removed: false, hasLeftoverData: false }
    }
    // 数据默认保留，卸载前先记录该插件是否遗留数据，由界面提示清理入口
    const leftover = hasPluginData(id)
    const dependents = store.activeDependents(id)
    if (dependents.length > 0) {
      report('pluginUninstallRejected', {
        id,
        reason: pluginReasonText(`depended-on:${dependents.join(', ')}`),
      })
      return { removed: false, hasLeftoverData: leftover }
    }
    await deactivateNow(id)
    const removed = store.remove(id)
    if (!removed) {
      return { removed: false, hasLeftoverData: leftover }
    }
    // 卸载只移除注册表与持久化记录；插件本地数据保留，交由设置的数据管理清理
    persist()
    return { removed: true, hasLeftoverData: leftover }
  }

  /** 生命周期入口：同一插件的操作排队执行，后一次等前一次结束后再读状态 */
  const activate = (id: string): Promise<boolean> => serialize(id, () => activateNow(id))
  const deactivate = (id: string): Promise<boolean> => serialize(id, () => deactivateNow(id))
  const unload = (id: string): Promise<UnloadResult> => serialize(id, () => unloadNow(id))

  /**
   * 运行时安装：清单以宿主传入的为准，未传时用产物自带的 manifest 导出，
   * 两者都没有则按清单非法拒绝。安装阶段下载产物字节并保存代码文本，
   * 带签名材料时先对原始字节验签，通过后才加载模块。
   */
  const installFromUrl = async (
    url: string,
    manifest?: PluginManifest,
    source?: InstallSource
  ): Promise<InstallResult> => {
    const target = manifest?.id ?? url
    const sourceType: PluginSourceType = source?.sourceType ?? 'outer'
    if (!isPluginSourceAllowed(url)) {
      // 地址判定与加载器一致：只接受 https 与本机回环的 http
      pushEngineLog(`install ${target} failed: source url is not allowed`)
      report('pluginInstallRejected', { id: target, reason: pluginReasonText('load-failed') })
      return { ok: false, reason: 'load-failed', detail: 'source url is not allowed' }
    }
    const material = await loadSignatureMaterial(url, source)
    // 安装阶段必须拿到字节：既要保存代码文本供启动恢复，也要对原始字节验签
    const bytes = await fetchArtifactBytes(url)
    if (!bytes) {
      // 字节没拿到时分不清网络问题与篡改，按加载失败处理，不误报签名无效
      pushEngineLog(`install ${target} failed: artifact fetch failed`)
      report('pluginInstallRejected', { id: target, reason: pluginReasonText('load-failed') })
      return { ok: false, reason: 'load-failed', detail: 'artifact fetch failed' }
    }
    if (bytes.length > MAX_PLUGIN_CODE_BYTES) {
      pushEngineLog(`install ${target} rejected: code is ${String(bytes.length)} bytes`)
      report('pluginInstallRejected', { id: target, reason: pluginReasonText('package-too-large') })
      return { ok: false, reason: 'package-too-large', detail: String(bytes.length) }
    }
    const codeText = decodePluginCode(bytes)
    if (codeText === null) {
      // 代码文本存不住就无法离线恢复，按加载失败处理
      pushEngineLog(`install ${target} failed: artifact is not valid UTF-8`)
      report('pluginInstallRejected', { id: target, reason: pluginReasonText('load-failed') })
      return { ok: false, reason: 'load-failed', detail: 'artifact is not valid UTF-8' }
    }
    const outcome = hasSignatureMaterial(material)
      ? await verifyArtifact(bytes, material)
      : {
          cms: null,
          author: null,
          chain: 'none' as ChainState,
          state: 'unverified' as SignatureState,
        }
    const signature: SignatureState = outcome.state
    // 来源结论只看本机结论：链通过且验签通过才是 confirmed，链不通过与拿不到证书都是确定的负面结论
    const { verdict, reason: verdictReason } = sourceVerdictOf({
      // 调用方没有给出来源信息时按「完全不知道来源」处理，结论为 unknown
      hasSource: source !== undefined,
      chain: outcome.chain,
      cms: outcome.cms,
    })
    // 链校验不通过时不会发起 CMS 验签，把这一步结论写进引擎日志便于排查
    if (material.eec !== '' && outcome.chain !== 'ok') {
      pushEngineLog(`install ${target}: certificate chain ${outcome.chain}, cms skipped`)
    }
    if (signature === 'failed') {
      // 签名不通过只提示，不阻断安装；安装记录标记为 failed，界面保留标识
      pushEngineLog(`install ${target}: signature-invalid, install anyway`)
      warn('pluginSignatureInvalid', { id: target })
    }
    if (source?.trustFailure === 'revoked') {
      // 证书已被吊销同样只提示，不阻断安装；安装记录标记为不可信
      pushEngineLog(`install ${target}: certificate-revoked, install anyway`)
      warn('pluginSignatureRevoked', { id: target })
    }
    let loadedModule: unknown
    try {
      loadedModule = await loadPluginModuleFromCode(codeText)
    } catch (error) {
      const detail = describeError(error)
      // 原始错误只进引擎日志，界面用可读文案
      pushEngineLog(`install ${target} failed: ${detail}`)
      report('pluginInstallRejected', { id: target, reason: pluginReasonText('load-failed') })
      return { ok: false, reason: 'load-failed', detail }
    }
    let loaded: LoadedPlugin
    try {
      loaded = await resolvePluginModule(loadedModule)
    } catch (error) {
      const detail = describeError(error)
      pushEngineLog(`install ${target} failed: ${detail}`)
      report('pluginInstallRejected', { id: target, reason: pluginReasonText('invalid-plugin') })
      return { ok: false, reason: 'invalid-plugin', detail }
    }
    const resolved = manifest ?? loaded.manifest
    if (!resolved) {
      report('pluginManifestMissing', { id: url })
      return { ok: false, reason: 'invalid-manifest' }
    }
    // 数据基址随安装入库：source_url 只用于检查更新，运行阶段直接按 dataBase 取资源
    const dataBase = normalizeDirectoryUrl(source?.dataBase) ?? deriveDataBase(url)
    const origin: store.PluginOrigin = {
      ...encodeSignature(material),
      eecAnchored: outcome.chain === 'ok',
      ...(source?.trust === undefined ? {} : { sourceTrust: source.trust }),
      ...(source?.trustFailure === undefined ? {} : { trustFailure: source.trustFailure }),
      sourceType,
      sourceUrl: url,
      dataBase,
      pluginBase: normalizeDirectoryUrl(source?.pluginBase) ?? derivePluginBase(dataBase),
      installedAt: Date.now(),
      trusted: source?.trustFailure !== 'revoked',
      code: codeText,
    }
    const result = register(resolved, loaded.plugin, { kind: 'url', url }, {
      origin,
      signature,
      verdict,
      verdictReason,
    })
    if (!result.ok) {
      return result
    }
    await activate(resolved.id)
    persist()
    return result
  }

  /**
   * 提交离线包：用包内代码建模块并注册。
   * 同 id 已存在时直接拒绝，不覆盖已有记录。
   */
  const commitLocalPackage = async (inspection: PackageInspection): Promise<InstallResult> => {
    const fallbackId =
      inspection.manifest?.id ?? toPluginId(inspection.meta.name) ?? inspection.meta.name
    if (store.get(fallbackId)) {
      report('pluginInstallRejected', { id: fallbackId, reason: pluginReasonText('duplicate') })
      return { ok: false, reason: 'duplicate' }
    }
    let loaded: LoadedPlugin
    try {
      loaded = await resolvePluginModule(await loadPluginModuleFromCode(inspection.codeText))
    } catch (error) {
      const detail = describeError(error)
      // 原始错误只进引擎日志，界面用可读文案
      pushEngineLog(`install local ${fallbackId} failed: ${detail}`)
      report('pluginInstallRejected', { id: fallbackId, reason: pluginReasonText('load-failed') })
      return { ok: false, reason: 'load-failed', detail }
    }
    const resolved = inspection.manifest ?? loaded.manifest
    if (!resolved) {
      report('pluginManifestMissing', { id: fallbackId })
      return { ok: false, reason: 'invalid-manifest' }
    }
    const material: SignatureMaterial = {
      eec: '',
      sig: null,
      authorPub: inspection.authorPub ?? '',
      authorSig: inspection.authorSig ?? null,
    }
    const origin: store.PluginOrigin = {
      ...encodeSignature(material),
      sourceType: 'local',
      installedAt: Date.now(),
      trusted: true,
      code: inspection.codeText,
    }
    const signature: SignatureState = hasSignatureMaterial(material)
      ? inspection.signatureFailed
        ? 'failed'
        : 'verified'
      : 'unverified'
    if (signature === 'failed') {
      // 签名不通过只提示，不阻断安装；安装记录标记为 failed，界面保留标识
      pushEngineLog(`install local ${fallbackId}: signature-invalid, install anyway`)
      warn('pluginSignatureInvalid', { id: fallbackId })
    }
    // 本地包没有来源，不参与来源判定，结论记为 local
    const result = register(resolved, loaded.plugin, { kind: 'local' }, {
      origin,
      signature,
      verdict: 'local',
    })
    if (!result.ok) {
      return result
    }
    await activate(resolved.id)
    persist()
    return result
  }

  /** 离线包预检：只读文件并校验，不改动注册表与安装记录 */
  const inspectLocalPackage = async (file: File): Promise<LocalPackageInspection> => {
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await file.arrayBuffer())
    } catch (error) {
      return { ok: false, reason: 'corrupt-package', detail: describeError(error) }
    }
    const read = readLocalPackage(file.name, bytes)
    if (!read.ok) {
      return read
    }
    const inspected = await inspectPackageFiles(read.files)
    if (!inspected.ok) {
      return inspected
    }
    const inspection = inspected.inspection
    const id =
      inspection.manifest?.id ?? toPluginId(inspection.meta.name) ?? inspection.meta.name
    if (inspection.incompleteSignature) {
      pushEngineLog(
        `local package ${file.name}: signature material is incomplete, install as unverified`
      )
    }
    if (inspection.signatureFailed) {
      pushEngineLog(`local package ${file.name}: signature-invalid, install as failed`)
    }
    const info: LocalPackageInfo = {
      id,
      name: inspection.meta.name,
      version: inspection.meta.version,
      author: inspection.meta.author,
      license: inspection.meta.license,
      description: inspection.meta.description,
      signatureVerified: inspection.authorPub
        ? inspection.signatureFailed
          ? 'failed'
          : 'verified'
        : 'unverified',
      installed: store.get(id) !== undefined,
    }
    return { ok: true, info, commit: () => commitLocalPackage(inspection) }
  }

  const installFromLocalFile = async (file: File): Promise<InstallResult> => {
    const inspected = await inspectLocalPackage(file)
    if (!inspected.ok) {
      report('pluginInstallRejected', {
        id: file.name,
        reason: pluginReasonText(inspected.reason, inspected.detail),
      })
      return { ok: false, reason: inspected.reason, detail: inspected.detail }
    }
    return await inspected.commit()
  }

  /**
   * 存储记录转成注册表用的来源元数据。
   * 旧记录可能没有数据基址,此时按 source_url 推导,恢复后再落盘补齐,更新检查不必回查 datalog.json。
   */
  const toOrigin = (entry: StoredPluginRecord): store.PluginOrigin => {
    const origin: store.PluginOrigin = {
      sourceType: entry.source_type,
      installedAt: entry.installed_at,
      trusted: entry.trusted !== false,
    }
    if (entry.source_url) {
      origin.sourceUrl = entry.source_url
    }
    const dataBase =
      entry.data_base ?? (entry.source_url ? deriveDataBase(entry.source_url) : undefined)
    if (dataBase) {
      origin.dataBase = dataBase
    }
    const pluginBase = entry.plugin_base ?? (dataBase ? derivePluginBase(dataBase) : undefined)
    if (pluginBase) {
      origin.pluginBase = pluginBase
    }
    if (entry.eec) {
      origin.eec = entry.eec
    }
    if (entry.eec_anchored === true) {
      origin.eecAnchored = true
    }
    if (entry.source_trust) {
      origin.sourceTrust = entry.source_trust
    }
    if (entry.trust_failure) {
      origin.trustFailure = entry.trust_failure
    }
    if (entry.sig) {
      origin.sig = entry.sig
    }
    if (entry.author_pub) {
      origin.authorPub = entry.author_pub
    }
    if (entry.author_sig) {
      origin.authorSig = entry.author_sig
    }
    if (entry.code) {
      origin.code = entry.code
    }
    return origin
  }

  /** 存储记录对应的恢复来源；在线插件没有分发地址时返回 null */
  const sourceOf = (entry: StoredPluginRecord): PluginSource | null => {
    if (entry.source_type === 'local') {
      return { kind: 'local' }
    }
    return entry.source_url ? { kind: 'url', url: entry.source_url } : null
  }

  /**
   * 恢复单个外部插件。
   * 只用存储的代码重建 Blob 模块,启动阶段不访问网络,离线也能激活;source_url 只用于检查更新。
   * 有签名材料时先对存储的代码字节验签,不通过只提示用户并把记录标记为不可信,仍然加载并激活。
   */
  const restoreExternal = async (entry: StoredPluginRecord): Promise<void> => {
    const id = entry.manifest.id
    const origin = toOrigin(entry)
    const source = sourceOf(entry)
    const code = entry.code ?? ''
    if (code === '') {
      // 没有代码就无法重建模块,只能等用户重新安装
      const record = store.addFailed(entry.manifest, source, 'no-plugin-instance', {
        origin,
        verdict: entry.source_type === 'local' ? 'local' : 'unknown',
      })
      record.enabled = entry.enabled
      report('pluginRestoreFailed', { id, reason: pluginReasonText('no-plugin-instance') })
      return
    }
    const material = decodeSignature({
      eec: entry.eec,
      sig: entry.sig,
      authorPub: entry.author_pub,
      authorSig: entry.author_sig,
    })
    const outcome = hasSignatureMaterial(material)
      ? // 验签对象是存储的代码文本重建出的字节,与安装时验签的原始字节一致
        await verifyArtifact(new TextEncoder().encode(code), material)
      : {
          cms: null,
          author: null,
          chain: 'none' as ChainState,
          state: 'unverified' as SignatureState,
        }
    const signature: SignatureState = outcome.state
    // 旧记录的 eec_anchored 不再直接采信:恢复时按存储的证书重新做链校验,结论只看本次结果
    const computed = sourceVerdictOf({
      hasSource: true,
      chain: outcome.chain,
      cms: outcome.cms,
    })
    // 锚定标记按本次链校验结果重写,旧记录里「证书来自清单」的旧语义不再沿用
    origin.eecAnchored = outcome.chain === 'ok'
    // 本地包没有来源,不参与来源判定
    const verdict: SourceVerdict = entry.source_type === 'local' ? 'local' : computed.verdict
    const verdictReason = entry.source_type === 'local' ? null : computed.reason
    if (signature === 'failed') {
      // 校验不通过只提示,不阻断激活;记录标记为不可信,界面保留标识
      origin.trusted = false
      warn('pluginSignatureInvalid', { id })
    }
    let loaded: LoadedPlugin
    try {
      loaded = await resolvePluginModule(await loadPluginModuleFromCode(code))
    } catch (error) {
      const reason = describeError(error)
      // 原始错误随占位记录写入插件日志,界面用可读文案
      const record = store.addFailed(entry.manifest, source, reason, {
        origin,
        signature,
        verdict,
        verdictReason,
      })
      record.enabled = entry.enabled
      report('pluginRestoreFailed', { id, reason: pluginReasonText(reason) })
      return
    }
    const result = register(entry.manifest, loaded.plugin, source, {
      origin,
      signature,
      verdict,
      verdictReason,
    })
    const record = store.get(id)
    if (!result.ok || !record) {
      return
    }
    record.enabled = entry.enabled
    if (signature === 'failed') {
      store.pushLog(record, 'signature-invalid')
    }
    if (record.enabled) {
      await activate(id)
    }
  }

  /**
   * 启动恢复：先装载内置插件，再按存储顺序恢复外部插件，保证依赖先于下游注册。
   * 外部插件全部用存储的代码重建模块，启动阶段不发起网络请求，网络不可达时照常启动。
   * 单个插件失败只记录为 failed，不阻塞其余插件与宿主渲染。
   */
  const restore = async (): Promise<void> => {
    const loaded = await loadPluginRecords()
    if (loaded.problem) {
      pushEngineLog(`restore: ${loaded.problem}`)
    }
    const byId = new Map(loaded.records.map((entry) => [entry.id, entry]))
    for (const builtin of BUILTIN_PLUGINS) {
      const id = builtin.manifest.id
      const stored = byId.get(id)
      const result = register(builtin.manifest, builtin.factory(), { kind: 'builtin' }, {
        origin: {
          sourceType: 'inner',
          installedAt: stored?.installed_at ?? Date.now(),
          trusted: true,
        },
      })
      const record = store.get(id)
      if (!result.ok || !record) {
        continue
      }
      // 首次出现的内置插件默认启用
      record.enabled = stored ? stored.enabled : true
      if (record.enabled) {
        await activate(id)
      }
    }
    const externals = loaded.records.filter((entry) => !BUILTIN_PLUGIN_IDS.includes(entry.id))
    for (const entry of externals) {
      await restoreExternal(entry)
    }
    restoring = false
    persist()
  }

  const list = (): PluginStateView[] =>
    store.all().map((record) => ({
      id: record.manifest.id,
      name: record.manifest.name,
      version: record.manifest.version,
      state: record.state,
      source: record.source,
      sourceType: record.origin?.sourceType ?? 'inner',
      ...(record.origin?.dataBase === undefined ? {} : { dataBase: record.origin.dataBase }),
      sourceVerdict: record.verdict,
      sourceVerdictReason: record.verdictReason,
      ...(record.origin?.sourceTrust === undefined
        ? {}
        : { sourceTrust: record.origin.sourceTrust }),
      enabled: record.enabled,
      dependencies: [...(record.manifest.dependencies ?? [])],
      capabilities: [...record.manifest.capabilities],
      contributions: [...record.contributions.keys()],
      error: record.error,
    }))

  // 引擎与应用同生命周期，事件订阅不需要单独释放
  void core.subscribe({ credential, ticket: issueTicket('events:session') }, dispatch)

  for (const id of BUILTIN_PLUGIN_IDS) {
    store.markBuiltinPlugin(id)
  }

  engine = {
    version: CORE_VERSION,
    install,
    installFromUrl,
    inspectLocalPackage,
    installFromLocalFile,
    activate,
    deactivate,
    unload,
    list,
    logs: (id) => store.get(id)?.logs ?? [],
    engineLogs: () => engineLogs,
    bypassEvents: readBypassEvents,
  }

  // 恢复在内部异步进行，installPluginEngine 保持同步返回，不阻塞首屏渲染
  void restore()
    .catch((error: unknown) => {
      pushEngineLog(`restore failed: ${describeError(error)}`)
    })
    .finally(() => {
      // 恢复提前失败时解除落盘抑制，避免后续操作一直不落盘
      restoring = false
    })
  return engine
}

/** 取已安装的引擎；未安装时返回 null */
export const getPluginEngine = (): PluginEngine | null => engine

export type {
  CallOptions,
  ContributionHandler,
  ContributionPoint,
  DscPlugin,
  EventsCapability,
  InstallResult,
  LoadedPlugin,
  LocalPackageInfo,
  LocalPackageInspection,
  NetCapability,
  NetResponse,
  PluginContext,
  PluginManifest,
  PluginModule,
  PluginSource,
  PluginSourceType,
  PluginState,
  PluginStateView,
  SessionsCapability,
  SettingsCapability,
  SignatureState,
  SourceTrustFailure,
  SourceTrustState,
  SourceVerdict,
  SourceVerdictReason,
  StorageCapability,
  UiCapability,
} from './types.js'
export { CONTRIBUTION_POINTS } from './types.js'
