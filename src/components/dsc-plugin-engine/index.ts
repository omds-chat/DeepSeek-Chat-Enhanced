import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import { pluginReasonText } from '../../i18n/pluginReasons.js'
import { showToast } from '../base/toastState.js'
import {
  CORE_VERSION,
  createCredential,
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
  inspectPackageFiles,
  readLocalPackage,
  toPluginId,
  type PackageInspection,
} from './localPackage.js'
import { loadPluginModule, loadPluginModuleFromCode, resolvePluginModule } from './loader.js'
import * as store from './registry.js'
import {
  decodeSignature,
  encodeSignature,
  fetchArtifactBytes,
  fetchArtifactText,
  hasSignatureMaterial,
  verifyArtifact,
  type SignatureMaterial,
} from './signature.js'
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
} from './types.js'

/** 激活与停用的时间上限（毫秒） */
const ACTIVATE_TIMEOUT = 5000
const DEACTIVATE_TIMEOUT = 3000
/** 引擎自身日志上限 */
const MAX_ENGINE_LOG = 100
/** 启动签名校验的并发上限 */
const VERIFY_CONCURRENCY = 4

/** 启动校验结论；unreachable 表示字节没拿到，不能据此判定篡改 */
type RestoreVerdict = SignatureState | 'unreachable'

/**
 * 安装时携带的来源信息。
 * eec 与 sigUrl 齐全时做合集 CMS 验签，authorPubUrl 与 authorSigUrl 齐全时做作者裸签名验签；
 * eec 缺省时按 eecUrl 拉取来源自带的证书。
 */
export type InstallSource = {
  sourceType: PluginSourceType
  /** 合集 EEC 证书 PEM */
  eec?: string
  /** 来源自带的 eec.pem 地址；eec 缺省时使用 */
  eecUrl?: string
  /** plugin.js.sig 地址；缺省为 <url>.sig */
  sigUrl?: string
  /** 作者公钥地址；缺省时不校验作者签名 */
  authorPubUrl?: string
  /** 作者签名地址；缺省为 <url>.author.sig */
  authorSigUrl?: string
  /** 信任清单给出的吊销结论；revoked 表示合集 EEC 证书已被吊销 */
  trustFailure?: 'revoked'
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
  unload(id: string): Promise<boolean>
  list(): PluginStateView[]
  logs(id: string): readonly string[]
  /** 引擎自身的日志，例如落盘与恢复失败 */
  engineLogs(): readonly string[]
  bypassEvents(): readonly BypassEvent[]
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** 以固定并发上限处理列表；单个任务抛错不影响其余任务 */
const runLimited = async <T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> => {
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      try {
        await task(item)
      } catch {
        // 单项失败由任务自身收敛，这里只保证其余项继续
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

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
    if (origin.eec) {
      stored.eec = origin.eec
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

  const unloadNow = async (id: string): Promise<boolean> => {
    const record = store.get(id)
    if (!record) {
      return false
    }
    const dependents = store.activeDependents(id)
    if (dependents.length > 0) {
      report('pluginUninstallRejected', {
        id,
        reason: pluginReasonText(`depended-on:${dependents.join(', ')}`),
      })
      return false
    }
    await deactivateNow(id)
    const removed = store.remove(id)
    if (!removed) {
      return false
    }
    // 卸载即清理该插件的本地数据；清理失败只记引擎日志，不影响卸载结果
    try {
      core.clearPluginData({ credential, ticket: issueTicket('plugins:data-clear') }, id)
    } catch (error) {
      pushEngineLog(`clear plugin data failed: ${describeError(error)}`)
    }
    persist()
    return true
  }

  /** 生命周期入口：同一插件的操作排队执行，后一次等前一次结束后再读状态 */
  const activate = (id: string): Promise<boolean> => serialize(id, () => activateNow(id))
  const deactivate = (id: string): Promise<boolean> => serialize(id, () => deactivateNow(id))
  const unload = (id: string): Promise<boolean> => serialize(id, () => unloadNow(id))

  /**
   * 收集签名材料：合集证书与 CMS 签名、作者公钥与作者签名。
   * 证书优先用调用方传入的 PEM（来自 online-data 信任清单），否则按 eecUrl 拉取来源自带的 eec.pem；
   * 缺少哪一项就跳过对应的校验，由界面按未校验展示。
   */
  const loadSignatureMaterial = async (
    url: string,
    source?: InstallSource
  ): Promise<SignatureMaterial> => {
    const declaredEec = source?.eec ?? ''
    const [eecText, authorPubText] = await Promise.all([
      declaredEec !== '' ? Promise.resolve(declaredEec) : fetchArtifactText(source?.eecUrl ?? ''),
      fetchArtifactText(source?.authorPubUrl ?? ''),
    ])
    const eec = eecText ?? ''
    const authorPub = authorPubText ?? ''
    const [sig, authorSig] = await Promise.all([
      eec === '' ? Promise.resolve(null) : fetchArtifactBytes(source?.sigUrl ?? url + '.sig'),
      authorPub === ''
        ? Promise.resolve(null)
        : fetchArtifactBytes(source?.authorSigUrl ?? url + '.author.sig'),
    ])
    return { eec, sig, authorPub, authorSig }
  }

  /**
   * 运行时安装：清单以宿主传入的为准，未传时用产物自带的 manifest 导出，
   * 两者都没有则按清单非法拒绝。带签名材料时先校验产物签名，通过后才加载。
   */
  const installFromUrl = async (
    url: string,
    manifest?: PluginManifest,
    source?: InstallSource
  ): Promise<InstallResult> => {
    const target = manifest?.id ?? url
    const sourceType: PluginSourceType = source?.sourceType ?? 'outer'
    const material = await loadSignatureMaterial(url, source)
    let signature: SignatureState = 'unverified'
    if (hasSignatureMaterial(material)) {
      const bytes = await fetchArtifactBytes(url)
      if (!bytes) {
        // 字节没拿到时分不清网络问题与篡改，按加载失败处理，不误报签名无效
        pushEngineLog(`install ${target} failed: artifact fetch failed`)
        report('pluginInstallRejected', { id: target, reason: pluginReasonText('load-failed') })
        return { ok: false, reason: 'load-failed', detail: 'artifact fetch failed' }
      }
      signature = await verifyArtifact(bytes, material)
      if (signature === 'failed') {
        // 签名不通过只提示，不阻断安装；安装记录标记为 failed，界面保留标识
        pushEngineLog(`install ${target}: signature-invalid, install anyway`)
        warn('pluginSignatureInvalid', { id: target })
      }
    }
    if (source?.trustFailure === 'revoked') {
      // 证书已被吊销同样只提示，不阻断安装；安装记录标记为不可信
      pushEngineLog(`install ${target}: certificate-revoked, install anyway`)
      warn('pluginSignatureRevoked', { id: target })
    }
    let loadedModule: unknown
    try {
      loadedModule = await loadPluginModule(url)
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
    const origin: store.PluginOrigin = {
      ...encodeSignature(material),
      sourceType,
      sourceUrl: url,
      installedAt: Date.now(),
      trusted: source?.trustFailure !== 'revoked',
    }
    const result = register(resolved, loaded.plugin, { kind: 'url', url }, { origin, signature })
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
    const result = register(resolved, loaded.plugin, { kind: 'local' }, { origin, signature })
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

  /** 存储记录转成注册表用的来源元数据 */
  const toOrigin = (entry: StoredPluginRecord): store.PluginOrigin => {
    const origin: store.PluginOrigin = {
      sourceType: entry.source_type,
      installedAt: entry.installed_at,
      trusted: entry.trusted !== false,
    }
    if (entry.source_url) {
      origin.sourceUrl = entry.source_url
    }
    if (entry.eec) {
      origin.eec = entry.eec
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

  /**
   * 恢复单个外部插件。
   * 签名不通过的记录仍然加载并激活，只提示用户并把记录标记为不可信，界面保留标识。
   */
  const restoreExternal = async (
    entry: StoredPluginRecord,
    verdict: RestoreVerdict | undefined
  ): Promise<void> => {
    const id = entry.manifest.id
    const origin = toOrigin(entry)
    const source: PluginSource | null = entry.source_url
      ? { kind: 'url', url: entry.source_url }
      : null
    const signature: SignatureState =
      verdict === 'verified' ? 'verified' : verdict === 'failed' ? 'failed' : 'unverified'
    if (verdict === 'failed') {
      // 校验不通过只提示，不阻断激活；记录标记为不可信，界面保留标识
      origin.trusted = false
      warn('pluginSignatureInvalid', { id })
    }
    if (!entry.source_url) {
      // 没有分发地址的记录无法恢复，只能等用户重新安装
      const record = store.addFailed(entry.manifest, source, 'no-plugin-instance', {
        origin,
        signature,
      })
      record.enabled = entry.enabled
      report('pluginRestoreFailed', { id, reason: pluginReasonText('no-plugin-instance') })
      return
    }
    if (verdict === 'unreachable') {
      // 网络不可达不算篡改，按恢复失败处理
      const record = store.addFailed(entry.manifest, source, 'load-failed', { origin, signature })
      record.enabled = entry.enabled
      store.pushLog(record, 'artifact fetch failed')
      report('pluginRestoreFailed', { id, reason: pluginReasonText('load-failed') })
      return
    }
    let loaded: LoadedPlugin
    try {
      loaded = await resolvePluginModule(await loadPluginModule(entry.source_url))
    } catch (error) {
      const reason = describeError(error)
      // 原始错误随占位记录写入插件日志，界面用可读文案
      const record = store.addFailed(entry.manifest, source, reason, { origin, signature })
      record.enabled = entry.enabled
      report('pluginRestoreFailed', { id, reason: pluginReasonText(reason) })
      return
    }
    const result = register(entry.manifest, loaded.plugin, source, { origin, signature })
    const record = store.get(id)
    if (!result.ok || !record) {
      return
    }
    record.enabled = entry.enabled
    if (verdict === 'failed') {
      store.pushLog(record, 'signature-invalid')
    }
    if (record.enabled) {
      await activate(id)
    }
  }

  /**
   * 恢复本地插件：用存储的代码重建 Blob 模块，有签名材料时先对代码验签。
   * 验签不通过只提示用户并把记录标记为不可信，仍然加载并激活。
   */
  const restoreLocal = async (entry: StoredPluginRecord): Promise<void> => {
    const id = entry.manifest.id
    const origin = toOrigin(entry)
    const source: PluginSource = { kind: 'local' }
    const code = entry.code ?? ''
    if (code === '') {
      // 没有代码就无法重建模块，只能等用户重新安装
      const record = store.addFailed(entry.manifest, source, 'no-plugin-instance', { origin })
      record.enabled = entry.enabled
      report('pluginRestoreFailed', { id, reason: pluginReasonText('no-plugin-instance') })
      return
    }
    let signature: SignatureState = 'unverified'
    const material = decodeSignature({
      eec: entry.eec,
      sig: entry.sig,
      authorPub: entry.author_pub,
      authorSig: entry.author_sig,
    })
    if (hasSignatureMaterial(material)) {
      // 本地插件没有可拉取的地址，验签对象是存储的代码文本重建出的字节
      signature = await verifyArtifact(new TextEncoder().encode(code), material)
      if (signature === 'failed') {
        // 校验不通过只提示，不阻断激活；记录标记为不可信，界面保留标识
        origin.trusted = false
        warn('pluginSignatureInvalid', { id })
      }
    }
    let loaded: LoadedPlugin
    try {
      loaded = await resolvePluginModule(await loadPluginModuleFromCode(code))
    } catch (error) {
      const reason = describeError(error)
      // 原始错误随占位记录写入插件日志，界面用可读文案
      const record = store.addFailed(entry.manifest, source, reason, { origin, signature })
      record.enabled = entry.enabled
      report('pluginRestoreFailed', { id, reason: pluginReasonText(reason) })
      return
    }
    const result = register(entry.manifest, loaded.plugin, source, { origin, signature })
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
   * 启动恢复：先装载内置插件，再恢复外部插件。
   * 外部插件先并发校验签名（上限 4），再按存储顺序逐个加载，保证依赖先于下游注册。
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
    // 校验只给出结论，不改动注册表；激活顺序仍按存储顺序
    const verdicts = new Map<string, RestoreVerdict>()
    await runLimited(externals, VERIFY_CONCURRENCY, async (entry) => {
      // 本地插件没有可拉取的地址，验签在 restoreLocal 里对存储的代码完成
      if (entry.source_type === 'local' || !entry.source_url) {
        return
      }
      const material = decodeSignature({
        eec: entry.eec,
        sig: entry.sig,
        authorPub: entry.author_pub,
        authorSig: entry.author_sig,
      })
      if (!hasSignatureMaterial(material)) {
        return
      }
      const bytes = await fetchArtifactBytes(entry.source_url)
      // 字节拉不到时按不可达处理，不误报篡改
      verdicts.set(entry.id, bytes ? await verifyArtifact(bytes, material) : 'unreachable')
    })
    for (const entry of externals) {
      if (entry.source_type === 'local') {
        await restoreLocal(entry)
      } else {
        await restoreExternal(entry, verdicts.get(entry.id))
      }
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
      signatureVerified: record.signature,
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
  StorageCapability,
  UiCapability,
} from './types.js'
export { CONTRIBUTION_POINTS } from './types.js'
