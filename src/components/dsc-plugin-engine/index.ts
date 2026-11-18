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
import { loadPluginModule, resolvePluginModule } from './loader.js'
import * as store from './registry.js'
import { verifyArtifactSignature, type ArtifactVerdict } from './signature.js'
import type {
  DscPlugin,
  InstallResult,
  LoadedPlugin,
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

/** 安装时携带的来源信息；pub 与 sign 同时给出才校验签名 */
export type InstallSource = {
  sourceType: PluginSourceType
  pub?: string
  sign?: string
}

/** 插件引擎对外接口 */
export type PluginEngine = {
  readonly version: string
  install(manifest: PluginManifest, plugin: DscPlugin): InstallResult
  /**
   * 运行时安装；manifest 缺省时使用产物自带的 manifest 导出。
   * source 缺省按 outer 处理且不校验签名；带 pub 与 sign 时先校验产物签名。
   */
  installFromUrl(
    url: string,
    manifest?: PluginManifest,
    source?: InstallSource
  ): Promise<InstallResult>
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
    if (origin.pub) {
      stored.pub = origin.pub
    }
    if (origin.sign) {
      stored.sign = origin.sign
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
   * 运行时安装：清单以宿主传入的为准，未传时用产物自带的 manifest 导出，
   * 两者都没有则按清单非法拒绝。带 pub 与 sign 时先校验产物签名，通过后才加载。
   */
  const installFromUrl = async (
    url: string,
    manifest?: PluginManifest,
    source?: InstallSource
  ): Promise<InstallResult> => {
    const target = manifest?.id ?? url
    const sourceType: PluginSourceType = source?.sourceType ?? 'outer'
    const pub = source?.pub ?? ''
    const sign = source?.sign ?? ''
    let signature: SignatureState = 'unverified'
    if (pub !== '' && sign !== '') {
      const verdict = await verifyArtifactSignature(url, pub, sign)
      if (verdict === 'unreachable') {
        // 字节没拿到时分不清网络问题与篡改，按加载失败处理，不误报签名无效
        pushEngineLog(`install ${target} failed: artifact fetch failed`)
        report('pluginInstallRejected', { id: target, reason: pluginReasonText('load-failed') })
        return { ok: false, reason: 'load-failed', detail: 'artifact fetch failed' }
      }
      if (verdict === 'failed') {
        pushEngineLog(`install ${target} rejected: signature-invalid`)
        report('pluginSignatureInvalid', { id: target })
        return { ok: false, reason: 'signature-invalid' }
      }
      signature = 'verified'
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
      sourceType,
      sourceUrl: url,
      installedAt: Date.now(),
      trusted: true,
    }
    if (pub !== '') {
      origin.pub = pub
    }
    if (sign !== '') {
      origin.sign = sign
    }
    const result = register(resolved, loaded.plugin, { kind: 'url', url }, { origin, signature })
    if (!result.ok) {
      return result
    }
    await activate(resolved.id)
    persist()
    return result
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
    if (entry.pub) {
      origin.pub = entry.pub
    }
    if (entry.sign) {
      origin.sign = entry.sign
    }
    return origin
  }

  /**
   * 恢复单个外部插件。
   * 签名不通过的记录保留在列表中，标记为不可信且不激活，供用户看到并手动卸载。
   */
  const restoreExternal = async (
    entry: StoredPluginRecord,
    verdict: ArtifactVerdict | undefined
  ): Promise<void> => {
    const id = entry.manifest.id
    const origin = toOrigin(entry)
    const source: PluginSource | null = entry.source_url
      ? { kind: 'url', url: entry.source_url }
      : null
    const signature: SignatureState =
      verdict === 'verified' ? 'verified' : verdict === 'failed' ? 'failed' : 'unverified'
    if (verdict === 'failed') {
      const record = store.addFailed(entry.manifest, source, 'signature-invalid', {
        origin: { ...origin, trusted: false },
        signature: 'failed',
      })
      record.enabled = entry.enabled
      store.pushLog(record, 'signature-invalid')
      report('pluginSignatureInvalid', { id })
      return
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
    const verdicts = new Map<string, ArtifactVerdict>()
    await runLimited(externals, VERIFY_CONCURRENCY, async (entry) => {
      if (!entry.source_url || !entry.pub || !entry.sign) {
        return
      }
      verdicts.set(entry.id, await verifyArtifactSignature(entry.source_url, entry.pub, entry.sign))
    })
    for (const entry of externals) {
      await restoreExternal(entry, verdicts.get(entry.id))
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
