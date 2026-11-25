import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import { pluginReasonText } from '../../i18n/pluginReasons.js'
import type { ManifestRevisions } from '../../services/integrity/manifest.js'
import { sourceEndpointPolicy } from '../../services/settings.js'
import { showToast } from '../base/toastState.js'
import {
  CORE_VERSION,
  clearPluginSettings,
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
  type CoreRequestPatch,
  type CoreRequestPreview,
  type CoreSourceDescriptor,
} from '../dsc-core/index.js'
import { createAssetAnnouncer } from './assetAccess.js'
import { createAssetDownloader, type DownloadCardSink } from './assetDownload.js'
import { createDownloadCardStore, formatAssetBytes } from './downloadCard.js'
import { checkTrustedCapability } from './registry.js'
import { clearPluginSecrets } from './credentials.js'
import { BUILTIN_PLUGIN_IDS, BUILTIN_PLUGINS } from './builtin.js'
import { createPluginContext, runWithTimeout } from './capabilities.js'
import {
  isLegacyInstallRecord,
  loadPluginRecords,
  readPendingConflicts,
  writePendingConflicts,
  writePluginRecords,
  type StoredPluginRecord,
} from './db.js'
import {
  decodePluginCode,
  inspectPackageFiles,
  readLocalPackage,
  type PackageInspection,
} from './localPackage.js'
import {
  checkDeactivatable,
  dependencyNodes as buildDependencyIndex,
  missingDependencies,
  type DependencyNode,
} from './dependencies.js'
import { isPluginSourceAllowed, loadPluginModuleFromCode, resolvePluginModule } from './loader.js'
import {
  isPendingConflictPlugin,
  mergePendingConflicts,
  prunePendingConflicts,
  samePendingConflicts,
} from './pendingConflicts.js'
import { convergePatch, mergePatch, REQUEST_PATCH_BUDGET_MS } from './requestPatch.js'
import {
  forgetSettings,
  forgetSettingsChangeListeners,
  pluginSettingsFacade,
  settingsDescriptor,
  type PluginSettingsFacade,
} from './pluginSettings.js'
import { toPluginId } from './pluginId.js'
import {
  dispatchSlotAction,
  forgetSlots,
  slotEntries,
  readSlotModel,
  type SlotActionPayload,
  type SlotActionResult,
  type SlotEntry,
  type SlotModelResult,
  type SlotName,
} from './pluginSlots.js'
import * as store from './registry.js'
import { declareSource, forgetSources, sourceView, type SourceRegistryView } from './sources.js'
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
  ActivateResult,
  ActivationConflict,
  ConflictDecisionResult,
  DeactivateOptions,
  DeactivateResult,
  DscPlugin,
  InstallConflict,
  InstallResult,
  LoadedPlugin,
  LocalPackageInfo,
  LocalPackageInspection,
  PendingConflict,
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
 * eec 与 eecUrls 都提供合集证书：两者都有时优先用信任清单登记的 eec，省一次请求；
 * eecUrls 按顺序尝试，公开发布布局 certs/<合集 id>/<合集 id>-eec.crt 优先，
 * 旧站点的扁平布局 certs/<合集 id>-eec.crt 兼容，最旧的 eec.pem 最后兜底；
 * 证书必须在本地通过证书链校验才会用于 CMS 验签，链不通过时结论为 failed 且不再验签。
 * authorPubUrl 与 authorSigUrl 齐全时做作者裸签名验签；没有证书时 CMS 验签直接跳过。
 */
export type InstallSource = SignatureSource & {
  sourceType: PluginSourceType
  /** 该版本目录的地址,形如 <base>/plugins/<作者>/<插件>/<版本>/；缺省由 url 推导 */
  dataBase?: string
  /** 插件目录的地址,形如 <base>/plugins/<作者>/<插件>/；缺省由 dataBase 推导 */
  pluginBase?: string
  /** 合集根目录数据是否已按 L1 清单校验通过；缺省按未校验处理 */
  catalogVerified?: boolean
  /** 该版本是否已按 L3 清单校验通过；缺省按未校验处理 */
  metaVerified?: boolean
  /** 各层清单 revision；写入安装记录，重装时用于回退提示 */
  revisions?: ManifestRevisions
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
  /** 启用插件；依赖未满足或与运行中的插件冲突时拒绝，并返回结构化原因 */
  activate(id: string): Promise<ActivateResult>
  /**
   * 停用插件；存在处于启用状态、依赖本插件的插件时拒绝，返回这些插件 id。
   * options.force 表示用户明确要求强行停用，结论同样是拒绝，引擎不连带停用依赖方。
   */
  deactivate(id: string, options?: DeactivateOptions): Promise<DeactivateResult>
  unload(id: string): Promise<UnloadResult>
  /**
   * 待决定的冲突组。
   * 冲突检测时引擎已把涉及的启用插件全部停用并写入记录；记录随插件卸载清理，
   * 涉及已卸载插件的冲突对不会出现在结果里。
   */
  pendingConflicts(): PendingConflict[]
  /**
   * 对待决定冲突组做选择：删除该组记录，按选择启用保留的那一个，其余保持停用。
   * 不连带启用依赖保留方的插件，依赖仍需用户自己满足。
   */
  resolvePendingConflict(groupId: string, keepId: string): Promise<ConflictDecisionResult>
  list(): PluginStateView[]
  logs(id: string): readonly string[]
  /** 引擎自身的日志，例如落盘与恢复失败 */
  engineLogs(): readonly string[]
  bypassEvents(): readonly BypassEvent[]
  /** 供应端点注册表视图：合并后的端点描述、能力矩阵与冲突记录 */
  sourceRegistry(): SourceRegistryView
  /** 插件设置表面：读描述、逐字段读值、写覆盖值与重置；供宿主设置页使用 */
  pluginSettings(pluginId: string): PluginSettingsFacade
  /** 已登记的全部 UI 槽位；宿主据此给每个登记项一个入口 */
  slots(): SlotEntry[]
  /**
   * 读一个槽位页面的当前模型：插件实现 ui:slot-data 时向插件索取，
   * 否则用登记时的描述静态显示；页面不存在（未登记或插件已停用）时拒绝。
   */
  readSlot(pluginId: string, slot: SlotName, id: string): SlotModelResult
  /** 分发一次槽位动作；refresh 为 true 时宿主随后调 readSlot 重新索取模型 */
  dispatchSlotAction(pluginId: string, payload: SlotActionPayload): SlotActionResult
  /** 撤销单个插件的全部槽位登记；卸载清理在引擎的 disposer 之外兜底一次 */
  unregisterSlotPlugin(pluginId: string): void
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
  // 资产来源的首次使用提示按「插件 + 来源」去重，去重状态与引擎同寿命
  const announceAsset = createAssetAnnouncer(warn)

  /**
   * assets:download 的提示出口: 每一次实际发生的传输都发一条气泡,
   * 不去重、不按来源合并; 卡片按插件复用, 同一插件同一时刻只有一张。
   * 取消按钮经 downloadCardStore 的回调回到下载执行器, 真正中止底层请求。
   */
  const downloadCardStore = createDownloadCardStore((pluginId, assetId) => {
    downloader.cancel(pluginId, assetId)
  })
  const downloadCard: DownloadCardSink = {
    onStart: (progress) => {
      downloadCardStore.onStart(progress)
      warn('pluginAssetDownloadStarted', {
        id: progress.pluginName,
        asset: progress.assetId,
        size: formatAssetBytes(progress.declaredBytes),
      })
    },
    onProgress: (progress) => {
      downloadCardStore.onProgress(progress)
    },
    onSettled: (pluginId) => {
      downloadCardStore.onSettled(pluginId)
    },
  }
  const downloader = createAssetDownloader(downloadCard)

  const engineLogs: string[] = []
  const pushEngineLog = (message: string) => {
    engineLogs.push(message)
    if (engineLogs.length > MAX_ENGINE_LOG) {
      engineLogs.shift()
    }
  }

  /**
   * 登记一条供应端点声明。
   * 冲突不阻断声明以外的任何流程：先声明的那份临时生效，后声明的不生效并记一条引擎日志，
   * 冲突同时出现在 sourceRegistry() 里，供设置界面展示。
   */
  const registerSource = (
    pluginId: string,
    descriptor: CoreSourceDescriptor
  ): ReturnType<typeof declareSource> => {
    const conflicts = declareSource(pluginId, descriptor, sourceEndpointPolicy())
    for (const conflict of conflicts) {
      pushEngineLog(
        'source ' +
          conflict.sourceId +
          ': ' +
          conflict.fields.join('/') +
          ' mismatch between ' +
          conflict.keptOwner +
          ' and ' +
          conflict.rejectedOwner +
          ', the first definition is kept'
      )
    }
    return conflicts
  }

  // 执行链路落在 capabilities.ts 与 providerRun.ts: 插件调 context.provider.run,
  // 引擎按注册表选出端点、按「端点 id + 基址」读凭证, 再带描述与载荷调 core 的 source:run。
  // 本版选中的端点固定为该能力在注册表里的第一个, 用户选择与其余七项能力留待后续。

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
    if (origin.catalogVerified) {
      stored.catalog_verified = true
    }
    if (origin.metaVerified) {
      stored.meta_verified = true
    }
    if (origin.revisions) {
      stored.manifest_revisions = origin.revisions
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

  /** 把核心事件分发给声明了该挂载点的插件；单个插件出错不影响其他插件 */
  const dispatch = (event: CoreEvent): void => {
    for (const record of store.all()) {
      if (record.state !== 'active') {
        continue
      }
      const handlers = record.mounts.get(event.type)
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

  /** 补丁相关的提示按「插件 + 原因」去重，每项只提示一次，避免每次请求都打扰用户 */
  const patchNotices = new Set<string>()

  const noticeOnce = (key: string, notify: () => void) => {
    if (patchNotices.has(key)) {
      return
    }
    patchNotices.add(key)
    notify()
  }

  /**
   * 请求前收集补丁：按登记顺序调用各已激活插件的处理器，全部处理器共用一份时间预算。
   * 任一处超时或抛错时整份补丁作废，请求按原参数发出；两种情形都只写引擎日志，不阻断请求。
   * 同步调用无法中断，超时按「处理点已超预算」判定：调用前与调用后各判一次，
   * 因此单个处理器自身超时也按超时处理。
   */
  const collectRequestPatch = (preview: CoreRequestPreview): CoreRequestPatch | null => {
    const startedAt = Date.now()
    const overdue = () => Date.now() - startedAt > REQUEST_PATCH_BUDGET_MS
    const abandoned = (id: string, called: number): null => {
      pushEngineLog(
        'chat:before-request: budget ' +
          String(REQUEST_PATCH_BUDGET_MS) +
          'ms exceeded after ' +
          String(called) +
          ' handler(s), request kept unchanged'
      )
      noticeOnce(id + ':timeout', () =>
        report('pluginCallTimeout', { id, capability: 'chat:before-request' })
      )
      return null
    }
    let merged: CoreRequestPatch | null = null
    let called = 0
    for (const record of store.all()) {
      if (record.state !== 'active' || record.requestHandlers.size === 0) {
        continue
      }
      const id = record.manifest.id
      for (const handler of [...record.requestHandlers]) {
        if (overdue()) {
          return abandoned(id, called)
        }
        called += 1
        let raw: unknown
        try {
          raw = handler(preview)
        } catch (error) {
          const detail = describeError(error)
          pushEngineLog(
            'chat:before-request ' + id + ': handler threw, request kept unchanged: ' + detail
          )
          store.pushLog(record, 'chat:before-request: ' + detail)
          return null
        }
        if (overdue()) {
          return abandoned(id, called)
        }
        const converged = convergePatch(raw)
        if (!converged) {
          continue
        }
        if (converged.clamped) {
          pushEngineLog('chat:before-request ' + id + ': patch clamped to limits')
          noticeOnce(id + ':clamped', () => warn('pluginRequestPatchClamped', { id }))
        }
        merged = merged === null ? converged.patch : mergePatch(merged, converged.patch)
      }
    }
    return merged
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
    // assets:download 只授予受信来源插件; 不满足时按 unknown-capability 拒绝,
    // 与能力不存在不可区分, 判定依据与安装记录写入的是同一份来源元数据
    const trusted = checkTrustedCapability(manifest, options.origin ?? null, options.verdict ?? 'unknown')
    if (trusted !== null) {
      report('pluginInstallRejected', { id: manifest.id, reason: pluginReasonText(trusted) })
      return { ok: false, reason: trusted }
    }
    store.add(manifest, plugin, source, options)
    // 冲突不再拒绝安装：检出的冲突对随结果带回，处置（警告、停用、待决定记录）由安装入口按启用状态完成
    return check.conflicts ? { ok: true, conflicts: check.conflicts } : { ok: true }
  }

  const install = (manifest: PluginManifest, plugin: DscPlugin): InstallResult => {
    const result = register(manifest, plugin, null)
    if (result.ok && result.conflicts) {
      // 宿主直接登记不自动启用，冲突只做警告与待决定记录；新插件本来就以停用状态登记
      settleInstallConflicts(manifest.id, result.conflicts)
    }
    return result
  }

  /**
   * 恢复既有记录：与安装期同一份清单与版本校验，但不判冲突。
   * 冲突判的是「新插件能否与已有记录共存」，恢复的是库里已经存在的记录：
   * 按冲突把其中一方拦下来等于把用户的插件丢掉；共存的冲突交给启用期与待决定记录处置。
   */
  const registerRestored = (
    manifest: PluginManifest,
    plugin: DscPlugin,
    source: PluginSource | null,
    options: store.RecordOptions = {}
  ): InstallResult => {
    const check = store.checkRestorable(manifest, CORE_VERSION)
    if (!check.ok) {
      pushEngineLog('restore ' + manifest.id + ' rejected: ' + check.reason)
      report('pluginRestoreFailed', {
        id: manifest.id,
        reason: pluginReasonText(check.reason, check.detail),
      })
      return check
    }
    // 恢复按安装期同一口径复核受信能力: 存储记录的来源结论不再是已确认时,
    // assets:download 不再可用, 恢复被拒并给出与安装一致的原因
    const trusted = checkTrustedCapability(manifest, options.origin ?? null, options.verdict ?? 'unknown')
    if (trusted !== null) {
      pushEngineLog('restore ' + manifest.id + ' rejected: ' + trusted)
      report('pluginRestoreFailed', { id: manifest.id, reason: pluginReasonText(trusted) })
      return { ok: false, reason: trusted }
    }
    store.add(manifest, plugin, source, options)
    return { ok: true }
  }

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

  /** 待决定冲突组的内存副本；每次变更同步落盘，界面读它不必等 IndexedDB */
  let pending: PendingConflict[] = []

  /** 落盘待决定记录；失败只记日志，内存副本照常服务界面 */
  const persistPending = (): void => {
    void writePendingConflicts(pending).then((result) => {
      if (!result.ok) {
        pushEngineLog('pending conflict persist failed: ' + result.reason)
      }
    })
  }

  /** 已安装插件 id 集合；待决定记录按它清理已卸载的插件 */
  const installedIds = (): Set<string> =>
    new Set(store.all().map((record) => record.manifest.id))

  /**
   * 按已卸载插件清理待决定记录，有改动时回写。
   * 卸载与启动恢复都走这里：记录里的插件卸载后「保留哪一个」已无从选择，冲突对随卸载失效。
   */
  const prunePending = (): void => {
    const pruned = prunePendingConflicts(pending, installedIds())
    if (samePendingConflicts(pending, pruned.groups)) {
      return
    }
    pending = pruned.groups
    pushEngineLog(
      'pending conflicts cleaned: ' +
        String(pruned.droppedGroups) +
        ' group(s) and ' +
        String(pruned.droppedPairs) +
        ' pair(s) dropped for uninstalled plugins'
    )
    persistPending()
  }

  /**
   * 安装期冲突的新口径：安装允许成功，冲突只警告不拒绝。
   * 对方记录处于启用状态时，新插件保持停用，冲突对写入待决定记录，
   * 由用户以后在插件面板决定保留哪一个（与启用期的保守处置共用同一份存储）；
   * 对方全部处于停用状态时只警告，不停用任何东西，安装照常自动启用。
   * 返回 true 表示新插件须保持停用（存在与已启用插件的冲突），安装入口据此跳过自动启用。
   */
  const settleInstallConflicts = (id: string, conflicts: readonly InstallConflict[]): boolean => {
    for (const conflict of conflicts) {
      pushEngineLog(
        'install ' + id + ': ' + conflict.kind + ' conflict ' + conflict.declarer + ' -> ' + conflict.target
      )
    }
    const opponentOf = (conflict: InstallConflict): string =>
      conflict.declarer === id ? conflict.target : conflict.declarer
    const activeOpponents = conflicts.filter(
      (conflict) => store.get(opponentOf(conflict))?.state === 'active'
    )
    if (activeOpponents.length > 0) {
      const ids = [...new Set(activeOpponents.map(opponentOf))].sort()
      pending = mergePendingConflicts(pending, activeOpponents, Date.now())
      persistPending()
      warn('pluginInstallConflictDisabled', { id, ids: ids.join(', ') })
      return true
    }
    const ids = [...new Set(conflicts.map(opponentOf))].sort()
    warn('pluginInstallConflictWarning', { id, ids: ids.join(', ') })
    return false
  }

  /**
   * 登记成功后的公共收尾：按冲突新口径处置，再自动启用。
   * 与已启用插件冲突时不发起启用，新插件保持停用；启用被拒时安装仍算成功，
   * 结论交给界面决定提示哪一条。冲突对随结果带回，供界面与调用方核对。
   */
  const finishInstall = async (
    id: string,
    conflicts: InstallConflict[] | undefined
  ): Promise<InstallResult> => {
    const stayDisabled = conflicts ? settleInstallConflicts(id, conflicts) : false
    if (stayDisabled) {
      persist()
      return { ok: true, conflicts }
    }
    const activation = await activate(id)
    persist()
    return conflicts ? { ok: true, activation, conflicts } : { ok: true, activation }
  }

  /**
   * 保守的冲突处理：先停用，再写入待决定记录，最后由用户决定保留哪一个。
   * 涉及的已启用插件全部停用（含正在运行的一方），本次要启用的插件同样保持停用：
   * 引擎不替用户选边，也不保留任何一方的启用意图。停用后依赖它们的插件按已有的依赖口径自动停用。
   * 逐条冲突写进引擎日志与本次插件的日志，并发一条警告说明冲突双方与方向。
   */
  const suspendForConflict = async (
    record: store.PluginRecord,
    conflicts: readonly ActivationConflict[]
  ): Promise<void> => {
    for (const conflict of conflicts) {
      const detail = conflict.declarer + ' -> ' + conflict.target
      pushEngineLog(
        'activate ' + record.manifest.id + ' suspended: ' + conflict.kind + ' conflict ' + detail
      )
      store.pushLog(record, 'activation-conflict: ' + conflict.kind + ' ' + detail)
    }
    const involved = new Set<string>([record.manifest.id])
    for (const conflict of conflicts) {
      involved.add(conflict.declarer)
      involved.add(conflict.target)
    }
    for (const id of [...involved].sort()) {
      const other = store.get(id)
      if (!other || other.state !== 'active') {
        continue
      }
      await stopRecord(other)
      store.pushLog(other, 'deactivate: conflict with ' + record.manifest.id)
      pushEngineLog('conflict: deactivated ' + id + ' (conflict with ' + record.manifest.id + ')')
    }
    // 冲突方停用后依赖它的插件失去依赖，按依赖未满足的既有口径自动停用
    await stopOrphanDependents()
    pending = mergePendingConflicts(pending, conflicts, Date.now())
    persistPending()
    persist()
    const first = conflicts[0]
    if (!first) {
      return
    }
    warn(
      first.kind === 'mutual' ? 'pluginConflictSuspendedMutual' : 'pluginConflictSuspendedSingle',
      {
        declarer: first.declarer,
        target: first.target,
        ids: [...involved].sort().join(', '),
        count: involved.size,
      }
    )
  }

  const activateNow = async (id: string): Promise<ActivateResult> => {
    const record = store.get(id)
    if (!record) {
      return { ok: false, reason: 'not-installed' }
    }
    if (record.state === 'active') {
      return { ok: true }
    }
    if (!record.plugin) {
      report('pluginRestoreFailed', {
        id,
        reason: pluginReasonText(record.error ?? 'no-plugin-instance'),
      })
      return { ok: false, reason: 'no-plugin-instance', detail: record.error }
    }
    // 启用期校验与安装期同一份清单：依赖须已激活，conflicts 中的插件不得正在运行
    const check = store.checkActivatable(id)
    if (!check.ok) {
      if (check.reason === 'conflict') {
        // 保守处理：冲突双方全部停用并写入待决定记录，由用户在插件面板选择保留哪一个
        await suspendForConflict(record, check.conflicts)
        return check
      }
      // 依赖未满足时不留下「已启用但坏了」的记录：直接按停用落盘，原因写进错误字段供列表展示
      const pending = check.detail ?? ''
      const detail = pending.split(',').join(', ')
      store.markInactive(record)
      record.error = `missing-dependency:${pending}`
      store.pushLog(record, 'activate-skipped: missing-dependency ' + detail)
      pushEngineLog('activate ' + id + ' skipped: dependencies not enabled: ' + detail)
      report('pluginActivateMissingDependency', {
        id,
        reason: pluginReasonText(`missing-dependency:${detail}`),
      })
      // 停用后它自己的依赖方同样拿不到依赖，一并按规定自动停用
      await stopOrphanDependents()
      persist()
      return check
    }
    try {
      const context = createPluginContext({
        record,
        core,
        credential,
        report,
        announceAsset,
        download: downloader.download,
        declareSource: registerSource,
      })
      await runWithTimeout(Promise.resolve(record.plugin.activate(context)), ACTIVATE_TIMEOUT, {
        onTimeout: () => report('pluginCallTimeout', { id, capability: 'activate' }),
      })
      store.markActive(record)
      persist()
      return { ok: true }
    } catch (error) {
      // 激活中途失败时同样要撤销已注册的处理器与端点声明，避免残留订阅与端点
      store.clearMounts(record)
      store.runDisposers(record)
      forgetSources(id)
      store.markFailed(record, describeError(error))
      // 原始错误只进插件日志，界面用可读文案
      store.pushLog(record, describeError(error))
      report('pluginActivateFailed', { id, reason: pluginReasonText(describeError(error)) })
      // 启动失败等同于依赖不可用，依赖它的插件据此自动停用
      await stopOrphanDependents()
      persist()
      return { ok: false, reason: 'activate-failed', detail: describeError(error) }
    }
  }

  /**
   * 依赖关系判定用的节点快照：注册表记录与插件视图同形，判定只落在 dependencies.ts 一处。
   */
  const dependencyNodeSnapshot = (): DependencyNode[] =>
    store.all().map((record) => ({
      id: record.manifest.id,
      state: record.state,
      dependencies: record.manifest.dependencies ?? [],
    }))

  /** 真正执行停用：先调插件的 deactivate，再清挂载点、释放函数与端点声明 */
  const stopRecord = async (record: store.PluginRecord): Promise<void> => {
    const id = record.manifest.id
    try {
      if (record.plugin?.deactivate) {
        await runWithTimeout(Promise.resolve(record.plugin.deactivate()), DEACTIVATE_TIMEOUT, {
          onTimeout: () => report('pluginCallTimeout', { id, capability: 'deactivate' }),
        })
      }
    } catch (error) {
      store.pushLog(record, describeError(error))
    } finally {
      store.clearMounts(record)
      store.runDisposers(record)
      // 停用后不再提供端点：声明随停用撤销，注册表随即回到其他声明方给出的定义
      forgetSources(id)
      store.markInactive(record)
    }
  }

  /**
   * 依赖不可用后自动停用依赖方。
   * 已激活的插件若依赖的插件不再处于启用状态（被停用、被卸载或启动失败），
   * 就先停用它，再逐轮停用它自己的已激活依赖方，直到没有插件的依赖未满足为止。
   * 每次自动停用都按「依赖未满足」写进该插件的错误与日志，并提示用户，方便事后在列表里看到原因。
   */
  const stopOrphanDependents = async (): Promise<void> => {
    for (;;) {
      const nodes = dependencyNodeSnapshot()
      const index = buildDependencyIndex(nodes)
      const orphan = nodes.find(
        (node) => node.state === 'active' && missingDependencies(node, index).length > 0
      )
      if (!orphan) {
        return
      }
      const record = store.get(orphan.id)
      if (!record) {
        return
      }
      const detail = missingDependencies(orphan, index).join(', ')
      await stopRecord(record)
      record.error = 'missing-dependency:' + detail
      store.pushLog(record, 'deactivate: dependency-missing ' + detail)
      pushEngineLog('auto-deactivate ' + orphan.id + ': dependencies not enabled: ' + detail)
      report('pluginDependencyAutoStopped', { id: orphan.id, dependency: detail })
    }
  }

  /**
   * 停用：先做依赖前置检查，仍有处于启用状态的插件依赖它时拒绝，并列出这些插件。
   * 强制标志只表示用户明确要求强行停用，同样按拒绝处理：引擎不自动连带停用依赖方，
   * 关联停用由用户先停用对方后再做。
   */
  const deactivateNow = async (
    id: string,
    options: DeactivateOptions = {}
  ): Promise<DeactivateResult> => {
    const record = store.get(id)
    if (!record || record.state !== 'active' || !record.plugin) {
      return { ok: false, reason: 'not-active' }
    }
    const check = checkDeactivatable(id, dependencyNodeSnapshot(), options)
    if (!check.ok) {
      const dependents = check.dependents.join(', ')
      pushEngineLog(
        'deactivate ' +
          id +
          ' rejected: still used by ' +
          dependents +
          (check.forced ? ', force requested but dependencies are not stopped' : '')
      )
      store.pushLog(record, 'deactivate-rejected: depended-on ' + dependents)
      report('pluginDeactivateRejected', {
        id,
        reason: pluginReasonText('depended-on:' + dependents),
      })
      return { ok: false, reason: 'depended-on', dependents: check.dependents, forced: check.forced }
    }
    await stopRecord(record)
    // 停用后依赖它的插件不再有可用的依赖，按依赖未满足自动停用并提示
    await stopOrphanDependents()
    persist()
    return { ok: true }
  }

  const unloadNow = async (id: string): Promise<UnloadResult> => {
    const record = store.get(id)
    if (!record) {
      return { removed: false, hasLeftoverData: false }
    }
    // 设置表面随卸载一并清理: 覆盖值与秘密值都由引擎管理, 插件离开后不留不可达的残留
    const settingFieldKeys = settingsDescriptor(id)?.fields.map((field) => field.key) ?? []
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
    // 未激活过的插件不会走 deactivateNow，这里再撤销一次端点声明
    forgetSources(id)
    // assets:download 不落盘, 没有持久数据要清; 活跃传输随卸载中止, 卡片随收尾收起
    downloader.cancelAll(id)
    forgetSettings(id)
    // 设置变更订阅随卸载一并撤销: 停用的 disposer 已撤过一次, 这里兜住未激活的残留
    forgetSettingsChangeListeners(id)
    // 槽位登记与动作、数据挂载点随卸载一并清理: 停用的 disposers 已撤过一次, 这里兜住未激活的残留
    forgetSlots(id)
    clearPluginSettings(id)
    void clearPluginSecrets(id, settingFieldKeys)
    patchNotices.delete(id + ':timeout')
    patchNotices.delete(id + ':clamped')
    // 记录移除后依赖它的插件拿不到依赖，按依赖未满足自动停用并提示
    await stopOrphanDependents()
    // 记录里的插件已卸载时「保留哪一个」无从选择，冲突对随卸载清理
    prunePending()
    persist()
    return { removed: true, hasLeftoverData: leftover }
  }

  /** 生命周期入口：同一插件的操作排队执行，后一次等前一次结束后再读状态 */
  const activate = (id: string): Promise<ActivateResult> => serialize(id, () => activateNow(id))
  const deactivate = (id: string, options?: DeactivateOptions): Promise<DeactivateResult> =>
    serialize(id, () => deactivateNow(id, options))
  const unload = (id: string): Promise<UnloadResult> => serialize(id, () => unloadNow(id))

  /**
   * 待决定冲突的只读快照。
   * 返回副本：界面按组渲染并可能过滤与排序，不应改动引擎里的事实。
   */
  const pendingConflicts = (): PendingConflict[] =>
    pending.map((group) => ({
      id: group.id,
      plugins: [...group.plugins],
      pairs: group.pairs.map((pair) => ({ ...pair })),
      at: group.at,
    }))

  /**
   * 用户对一条待决定冲突做出选择：先删记录，再按选择启用保留的那一个，其余保持停用。
   * 记录先删的理由是用户已经做了决定：启用失败时这组冲突不再待决定，失败原因由引擎提示，
   * 其余插件同样保持停用。不连带启用依赖方：保留方启用后，依赖它的插件仍需用户自己启用。
   */
  const resolvePendingConflict = async (
    groupId: string,
    keepId: string
  ): Promise<ConflictDecisionResult> => {
    const group = pending.find((item) => item.id === groupId)
    if (!group) {
      return { ok: false, reason: 'not-found' }
    }
    if (!group.plugins.includes(keepId)) {
      return { ok: false, reason: 'not-in-group' }
    }
    const kept = store.get(keepId)
    if (!kept) {
      return { ok: false, reason: 'not-installed' }
    }
    if (!kept.plugin) {
      return { ok: false, reason: 'no-plugin-instance' }
    }
    const stopped = group.plugins.filter((id) => id !== keepId)
    pending = pending.filter((item) => item.id !== groupId)
    persistPending()
    pushEngineLog(
      'pending conflict ' + groupId + ' resolved: keep ' + keepId + ', stop ' + stopped.join(',')
    )
    // 其余插件保持停用：待决定期间用户可能手动启用过其中一方，这里按选择统一停用。
    // 没在运行的也要清掉期望启用的标记：标记残留会让下次刷新自动启用它，
    // 与保留方再起冲突，刚处理完的待决定组又回到列表。
    for (const id of stopped) {
      const other = store.get(id)
      if (!other) {
        continue
      }
      if (other.state === 'active') {
        await stopRecord(other)
        store.pushLog(other, 'deactivate: conflict decision kept ' + keepId)
        pushEngineLog('conflict decision: deactivated ' + id + ' (kept ' + keepId + ')')
      } else if (other.enabled) {
        store.markInactive(other)
        store.pushLog(other, 'intent-cleared: conflict decision kept ' + keepId)
        pushEngineLog('conflict decision: ' + id + ' kept disabled (kept ' + keepId + ')')
      }
    }
    await stopOrphanDependents()
    const result = await activate(keepId)
    if (!result.ok) {
      return result.reason === 'conflict'
        ? { ok: false, reason: 'conflict', detail: result.detail }
        : { ok: false, reason: result.reason, ...(result.detail === undefined ? {} : { detail: result.detail }) }
    }
    persist()
    return { ok: true, kept: keepId, stopped }
  }

  /** 各层 revision 的键；与三层清单一一对应 */
  const REVISION_LAYERS = ['l1', 'l2', 'l3'] as const

  /**
   * 安装时比对清单 revision：某层小于本地记录值时只提示，不阻断安装。
   * 本地记录值取同一插件的上一条安装记录，没有记录时不比对。
   */
  const warnRevisionRegressions = (id: string, incoming?: ManifestRevisions): void => {
    if (incoming === undefined) {
      return
    }
    const previous = store.get(id)?.origin?.revisions
    if (previous === undefined) {
      return
    }
    for (const layer of REVISION_LAYERS) {
      const before = previous[layer]
      const now = incoming[layer]
      if (before === undefined || now === undefined || now >= before) {
        continue
      }
      pushEngineLog('install ' + id + ': ' + layer + ' revision ' + String(now) + ' < ' + String(before))
      warn('pluginManifestRevisionRegressed', { id, layer, seen: before, revision: now })
    }
  }

  /**
   * 运行时安装：清单以宿主传入的为准，未传时用产物自带的 manifest 导出，
   * 传入的清单缺 mounts 时用产物导出清单的挂载点补齐，两者都没有则按清单非法拒绝。
   * 安装阶段下载产物字节并保存代码文本，带签名材料时先对原始字节验签，通过后才加载模块。
   */
  const installFromUrl = async (
    url: string,
    manifest?: PluginManifest,
    source?: InstallSource
  ): Promise<InstallResult> => {
    const target = manifest?.id ?? url
    const sourceType: PluginSourceType = source?.sourceType ?? 'outer'
    if (!isPluginSourceAllowed(url)) {
      // 地址判定与加载器一致：只接受 https 与回环地址的 http
      pushEngineLog(`install ${target} failed: source url is not allowed`)
      report('pluginInstallRejected', { id: target, reason: pluginReasonText('load-failed') })
      return { ok: false, reason: 'load-failed', detail: 'source url is not allowed' }
    }
    const material = await loadSignatureMaterial(url, source)
    // 安装阶段必须拿到字节：既要保存代码文本供启动恢复，也要对原始字节验签
    const bytes = await fetchArtifactBytes(url)
    if (!bytes) {
      // 字节没拿到时分不清网络问题与篡改，按取件失败处理，不误报签名无效
      pushEngineLog(`install ${target} failed: artifact fetch failed`)
      report('pluginInstallRejected', { id: target, reason: pluginReasonText('artifact-unreachable') })
      return { ok: false, reason: 'artifact-unreachable', detail: 'artifact fetch failed' }
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
    // 来源结论只看本地结论：链通过且验签通过才是 confirmed，链不通过与拿不到证书都是确定的负面结论
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
    // 清单以调用方传入的为准；meta.json 推导的清单可能没有 mounts 与 slots，用产物导出的清单补齐
    const resolved =
      manifest === undefined
        ? loaded.manifest
        : store.withArtifactDeclarations(manifest, loaded.manifest)
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
      ...(source?.catalogVerified === undefined
        ? {}
        : { catalogVerified: source.catalogVerified }),
      ...(source?.metaVerified === undefined ? {} : { metaVerified: source.metaVerified }),
      ...(source?.revisions === undefined ? {} : { revisions: source.revisions }),
      sourceType,
      sourceUrl: url,
      dataBase,
      pluginBase: normalizeDirectoryUrl(source?.pluginBase) ?? derivePluginBase(dataBase),
      installedAt: Date.now(),
      trusted: source?.trustFailure !== 'revoked',
      code: codeText,
    }
    // 目录数据是否已校验只写进安装记录，不参与来源结论；revision 回退只提示
    warnRevisionRegressions(resolved.id, source?.revisions)
    const result = register(resolved, loaded.plugin, { kind: 'url', url }, {
      origin,
      signature,
      verdict,
      verdictReason,
    })
    if (!result.ok) {
      return result
    }
    return await finishInstall(resolved.id, result.conflicts)
  }

  /**
   * 提交离线包：用包内代码建模块并注册。
   * 包内 meta.json 推导的清单缺 mounts 时，用产物导出的清单补齐。
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
    // 离线包由 meta.json 推导的清单同样可能缺 mounts 与 slots，按同一口径用产物导出的清单补齐
    const resolved =
      inspection.manifest === null
        ? loaded.manifest
        : store.withArtifactDeclarations(inspection.manifest, loaded.manifest)
    if (!resolved) {
      // 插件名收敛不出合规 id 时，把原因指向命名而不是笼统的清单非法
      if (inspection.manifestProblem) {
        pushEngineLog(`install local ${fallbackId} rejected: ${inspection.manifestProblem}`)
      }
      report('pluginManifestMissing', { id: fallbackId })
      return {
        ok: false,
        reason: 'invalid-manifest',
        detail: inspection.manifestProblem ?? undefined,
      }
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
    // 与在线安装同一口径：冲突处置与自动启用走同一个收尾
    return await finishInstall(resolved.id, result.conflicts)
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
      // 预检失败的具体原因只进引擎日志，界面用通用文案
      if (inspected.detail !== undefined) {
        pushEngineLog(`local package ${file.name} rejected: ${inspected.reason} ${inspected.detail}`)
      }
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
   * 旧记录可能没有数据基址,此时按 source_url 推导,恢复后再落盘补齐,更新检查不必回查 plugins.json。
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
    if (entry.catalog_verified === true) {
      origin.catalogVerified = true
    }
    if (entry.meta_verified === true) {
      origin.metaVerified = true
    }
    if (entry.manifest_revisions) {
      origin.revisions = entry.manifest_revisions
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
    if (isLegacyInstallRecord(entry)) {
      origin.verificationMissing = true
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
   * 启动恢复时的自动启用。
   * 待决定冲突涉及的插件一律不自动启用：先按停用落盘并写日志，等用户在插件面板做出选择。
   * 不自动启用任何一方是这条策略的核心：记录里的双方都在用户选择前保持停用。
   */
  const autoActivate = async (id: string): Promise<void> => {
    const record = store.get(id)
    if (!record || !record.enabled) {
      return
    }
    if (isPendingConflictPlugin(pending, id)) {
      store.markInactive(record)
      store.pushLog(record, 'activate-skipped: pending-conflict')
      pushEngineLog('activate ' + id + ' skipped: waiting for the conflict decision')
      return
    }
    await activate(id)
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
    const result = registerRestored(entry.manifest, loaded.plugin, source, {
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
    await autoActivate(id)
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
    // 待决定记录先读出来：涉及其中任何一个插件都不自动启用，等用户选择；
    // 记录里的插件若已卸载（存储里没有这一条），这里按已装载的存储记录清理该条
    const storedConflicts = await readPendingConflicts()
    if (storedConflicts.problem) {
      pushEngineLog(`restore: ${storedConflicts.problem}`)
    }
    const prunedConflicts = prunePendingConflicts(storedConflicts.groups, new Set(byId.keys()))
    pending = prunedConflicts.groups
    if (prunedConflicts.droppedGroups > 0 || prunedConflicts.droppedPairs > 0) {
      pushEngineLog(
        'restore: cleaned ' +
          String(prunedConflicts.droppedGroups) +
          ' pending conflict group(s) and ' +
          String(prunedConflicts.droppedPairs) +
          ' pair(s) for uninstalled plugins'
      )
      persistPending()
    }
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
      await autoActivate(id)
    }
    const externals = loaded.records.filter((entry) => !BUILTIN_PLUGIN_IDS.includes(entry.id))
    for (const entry of externals) {
      await restoreExternal(entry)
    }
    // 恢复顺序可能让某个插件先于它的依赖启用，收尾时按依赖未满足统一自动停用
    await stopOrphanDependents()
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
      ...(record.origin?.catalogVerified === undefined && record.origin?.metaVerified === undefined
        ? {}
        : {
            catalogVerified:
              record.origin?.catalogVerified === true && record.origin?.metaVerified === true,
          }),
      sourceVerdict: record.verdict,
      sourceVerdictReason: record.verdictReason,
      ...(record.origin?.sourceTrust === undefined
        ? {}
        : { sourceTrust: record.origin.sourceTrust }),
      ...(record.origin?.trustFailure === undefined
        ? {}
        : { sourceTrustFailure: record.origin.trustFailure }),
      ...(record.origin?.verificationMissing === true ? { verificationMissing: true } : {}),
      ...(record.manifest.hostCapability === true ? { hostCapability: true } : {}),
      enabled: record.enabled,
      dependencies: [...(record.manifest.dependencies ?? [])],
      capabilities: [...record.manifest.capabilities],
      mounts: [...record.mounts.keys()],
      slots: [...(record.manifest.slots ?? [])],
      error: record.error,
    }))

  // 引擎与应用同生命周期，事件订阅不需要单独释放
  void core.subscribe({ credential, ticket: issueTicket('events:session') }, dispatch)
  // 请求补丁：core 在发请求前同步索取一次，引擎只负责收集与合并，不接触请求对象
  core.setRequestPatchSource(
    { credential, ticket: issueTicket('chat:request-source') },
    collectRequestPatch
  )

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
    pendingConflicts,
    resolvePendingConflict,
    list,
    logs: (id) => store.get(id)?.logs ?? [],
    engineLogs: () => engineLogs,
    bypassEvents: readBypassEvents,
    sourceRegistry: sourceView,
    pluginSettings: pluginSettingsFacade,
    slots: () => slotEntries(),
    readSlot: (pluginId, slot, id) => {
      const record = store.get(pluginId)
      const log = record ? (message: string) => store.pushLog(record, message) : undefined
      return readSlotModel(pluginId, slot, id, log)
    },
    dispatchSlotAction: (pluginId, payload) => {
      const record = store.get(pluginId)
      const log = record ? (message: string) => store.pushLog(record, message) : undefined
      return dispatchSlotAction(pluginId, payload, log)
    },
    unregisterSlotPlugin: forgetSlots,
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
  ActivateRejection,
  ActivateResult,
  ActivationConflict,
  ConflictDecisionResult,
  AssetBytesResult,
  AssetTextResult,
  AssetsCapability,
  BeforeRequestHandler,
  BeforeRequestPreview,
  CallOptions,
  ChatCapability,
  DeactivateOptions,
  DeactivateResult,
  DscPlugin,
  EventsCapability,
  InstallResult,
  LoadedPlugin,
  LocalPackageInfo,
  LocalPackageInspection,
  MountHandler,
  MountPoint,
  NetCapability,
  NetResponse,
  PendingConflict,
  PendingConflictPair,
  PluginContext,
  PluginManifest,
  PluginModule,
  PluginSource,
  PluginSourceType,
  ProviderCapability,
  PluginState,
  PluginStateView,
  RequestPatch,
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
export { MOUNT_POINTS } from './types.js'
/** 供应端点注册表：冲突判定与执行错误；注册表的读写入口经 engine.sourceRegistry() 暴露 */
export { PluginSourceError } from './sources.js'
/** 资产下载：失败码闭集与错误类型；清单 assets 块的声明形态实现在 assetDownload.ts */
export { PluginAssetDownloadError } from './assetDownload.js'
export type { AssetDownloadReason, PluginAsset } from './assetDownload.js'
/** 下载卡片状态：宿主订阅渲染右下角悬浮卡片，取消经引擎侧出口回到下载执行器 */
export type { DownloadCardData } from './downloadCard.js'
/** 设置表面：描述类型、校验错误与门面；注册与校验实现在 pluginSettings.ts */
export { PluginSettingsError, SETTING_KEY_PATTERN } from './pluginSettings.js'
export type { PluginSettingsFacade } from './pluginSettings.js'
export type {
  SettingDescriptor,
  SettingDescriptorProblem,
  SettingFieldDescriptor,
  SettingFieldOptions,
  SettingFieldType,
  SettingOverride,
  SettingValue,
  SettingValueProblem,
  SettingValueView,
  SettingWriteResult,
  SettingsChange,
  SettingsChangeHandler,
  SettingsChangeKind,
  SettingsFieldChange,
} from './pluginSettings.js'
/**
 * 插件 UI 槽位：错误类型、键规则与登记表订阅；登记、校验与槽位授权实现在 pluginSlots.ts。
 * 宿主按登记表列出侧边栏导航行、会话视图标签栏与会话右栏的段落和标签页, 登记变化经订阅通知界面。
 */
export {
  PAGE_KEY_PATTERN,
  SLOT_COMPOSER_NOTICE,
  SLOT_COMPOSER_TOOLBAR,
  SLOT_CONVERSATION_TABS,
  SLOT_MENU_ITEM,
  SLOT_MESSAGE_ACTIONS,
  SLOT_NAMES,
  SLOT_NAV_PANEL,
  SLOT_NAV_SIDE,
  SLOT_OVERLAY_NOTICE,
  SLOT_SESSION_PANEL_SECTION,
  SLOT_SETTINGS_PAGE,
  PluginPageError,
  PluginSlotError,
  isPageDescriptor,
  isPageSlot,
  isPanelEntrySlot,
  slotRegistryRevision,
  subscribeSlotRegistry,
} from './pluginSlots.js'
export type {
  ComposerNoticeDescriptor,
  ComposerToolbarDescriptor,
  MenuItemDescriptor,
  MenuTarget,
  MessageActionsDescriptor,
  NoticeLevel,
  OverlayNoticeDescriptor,
  PageActionDescriptor,
  PanelEntrySlotName,
  PageBlock,
  PageBlockType,
  PageDescriptor,
  PageSlotDescriptor,
  PageSlotName,
  PageDescriptorProblem,
  PageFormBlock,
  PageListItemDescriptor,
  PageListBlock,
  PageTextBlock,
  PageActionsBlock,
  SlotActionHandler,
  SlotActionPayload,
  SlotActionResponse,
  SlotActionResult,
  SlotDataHandler,
  SlotDescriptor,
  SlotDescriptorBody,
  SlotDescriptorProblem,
  SlotEntry,
  SlotHandle,
  SlotModelResult,
  SlotName,
} from './pluginSlots.js'
/** 按端点执行：错误码、错误类型与结果形态 */
export { PluginProviderRunError, PROVIDER_RUN_ERROR_CODES } from './providerRun.js'
export type {
  ProviderModelsResult,
  ProviderRunErrorCode,
  ProviderRunPayload,
  ProviderRunResult,
  ProviderStreamResult,
} from './providerRun.js'
export type {
  SourceCapabilityMatrix,
  SourceConflict,
  SourceConflictField,
  SourceRegistryView,
} from './sources.js'
