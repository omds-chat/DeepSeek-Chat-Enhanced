import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
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
import { loadPluginModule, resolvePluginModule } from './loader.js'
import * as store from './registry.js'
import { loadInstalled, saveInstalled } from './storage.js'
import type {
  DscPlugin,
  InstallResult,
  LoadedPlugin,
  PluginManifest,
  PluginSource,
  PluginStateView,
} from './types.js'

/** 激活与停用的时间上限（毫秒） */
const ACTIVATE_TIMEOUT = 5000
const DEACTIVATE_TIMEOUT = 3000
/** 引擎自身日志上限 */
const MAX_ENGINE_LOG = 100

/** 插件引擎对外接口 */
export type PluginEngine = {
  readonly version: string
  install(manifest: PluginManifest, plugin: DscPlugin): InstallResult
  /** 运行时安装；manifest 缺省时使用产物自带的 manifest 导出 */
  installFromUrl(url: string, manifest?: PluginManifest): Promise<InstallResult>
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

  /** 把当前注册表落盘；失败只记日志，不影响内存状态 */
  const persist = (): void => {
    const entries = store
      .all()
      .filter((record) => record.source !== null)
      .map((record) => ({
        manifest: record.manifest,
        source: record.source as PluginSource,
        enabled: record.enabled,
      }))
    const result = saveInstalled(entries)
    if (!result.ok) {
      pushEngineLog(`persist failed: ${result.reason}`)
    }
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
    source: PluginSource | null
  ): InstallResult => {
    const check = store.checkInstallable(manifest, CORE_VERSION)
    if (!check.ok) {
      report('pluginInstallRejected', { id: manifest.id, reason: check.reason })
      return check
    }
    store.add(manifest, plugin, source)
    return { ok: true }
  }

  const install = (manifest: PluginManifest, plugin: DscPlugin): InstallResult =>
    register(manifest, plugin, null)

  const activate = async (id: string): Promise<boolean> => {
    const record = store.get(id)
    if (!record) {
      return false
    }
    if (record.state === 'active') {
      return true
    }
    if (!record.plugin) {
      report('pluginRestoreFailed', { id, reason: record.error ?? 'no-plugin-instance' })
      return false
    }
    const pending = store.pendingDependencies(record)
    if (pending.length > 0) {
      store.markFailed(record, `missing-dependency:${pending.join(',')}`)
      report('pluginActivateFailed', { id, reason: `missing-dependency:${pending[0]}` })
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
      report('pluginActivateFailed', { id, reason: describeError(error) })
      persist()
      return false
    }
  }

  const deactivate = async (id: string): Promise<boolean> => {
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

  const unload = async (id: string): Promise<boolean> => {
    const record = store.get(id)
    if (!record) {
      return false
    }
    const dependents = store.activeDependents(id)
    if (dependents.length > 0) {
      report('pluginInstallRejected', { id, reason: `depended-on:${dependents[0]}` })
      return false
    }
    await deactivate(id)
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

  /**
   * 运行时安装：清单以宿主传入的为准，未传时用产物自带的 manifest 导出，
   * 两者都没有则按清单非法拒绝。
   */
  const installFromUrl = async (
    url: string,
    manifest?: PluginManifest
  ): Promise<InstallResult> => {
    let loadedModule: unknown
    try {
      loadedModule = await loadPluginModule(url)
    } catch (error) {
      report('pluginInstallRejected', {
        id: manifest?.id ?? url,
        reason: `load:${describeError(error)}`,
      })
      return { ok: false, reason: 'load-failed', detail: describeError(error) }
    }
    let loaded: LoadedPlugin
    try {
      loaded = await resolvePluginModule(loadedModule)
    } catch (error) {
      report('pluginInstallRejected', {
        id: manifest?.id ?? url,
        reason: `resolve:${describeError(error)}`,
      })
      return { ok: false, reason: 'invalid-plugin', detail: describeError(error) }
    }
    const resolved = manifest ?? loaded.manifest
    if (!resolved) {
      report('pluginManifestMissing', { id: url })
      return { ok: false, reason: 'invalid-manifest' }
    }
    const result = register(resolved, loaded.plugin, { kind: 'url', url })
    if (!result.ok) {
      return result
    }
    await activate(resolved.id)
    persist()
    return result
  }

  /**
   * 启动恢复：先装载内置插件，再恢复外部插件。
   * 单个插件失败只记录为 failed，不阻塞其余插件与宿主渲染。
   */
  const restore = async (): Promise<void> => {
    const saved = loadInstalled()
    if (saved.problem) {
      pushEngineLog(`restore: ${saved.problem}`)
    }
    const byId = new Map(saved.entries.map((entry) => [entry.manifest.id, entry]))
    for (const builtin of BUILTIN_PLUGINS) {
      const id = builtin.manifest.id
      const stored = byId.get(id)
      const result = register(builtin.manifest, builtin.factory(), { kind: 'builtin' })
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
    for (const entry of saved.entries) {
      if (entry.source.kind !== 'url' || BUILTIN_PLUGIN_IDS.includes(entry.manifest.id)) {
        continue
      }
      let loaded: LoadedPlugin
      try {
        loaded = await resolvePluginModule(await loadPluginModule(entry.source.url))
      } catch (error) {
        const reason = describeError(error)
        store.addFailed(entry.manifest, entry.source, reason)
        report('pluginRestoreFailed', { id: entry.manifest.id, reason })
        continue
      }
      const result = register(entry.manifest, loaded.plugin, entry.source)
      const record = store.get(entry.manifest.id)
      if (!result.ok || !record) {
        continue
      }
      record.enabled = entry.enabled
      if (record.enabled) {
        await activate(entry.manifest.id)
      }
    }
    persist()
  }

  const list = (): PluginStateView[] =>
    store.all().map((record) => ({
      id: record.manifest.id,
      name: record.manifest.name,
      version: record.manifest.version,
      state: record.state,
      source: record.source,
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
  void restore().catch((error: unknown) => {
    pushEngineLog(`restore failed: ${describeError(error)}`)
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
  PluginState,
  PluginStateView,
  SessionsCapability,
  SettingsCapability,
  StorageCapability,
  UiCapability,
} from './types.js'
export { CONTRIBUTION_POINTS } from './types.js'
