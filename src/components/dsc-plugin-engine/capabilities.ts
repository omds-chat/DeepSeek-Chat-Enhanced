import {
  checkSourceDescriptor,
  PluginDataError,
  issueTicket,
  type AssetBytesResult,
  type AssetTextResult,
  type CoreApi,
  type CoreCall,
  type CoreCapabilityId,
  type CoreCredential,
  type CoreSourceDescriptor,
} from '../dsc-core/index.js'
import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import { isBuiltinPlugin, type PluginRecord } from './registry.js'
import { PluginSourceError, type SourceConflict } from './sources.js'
import type {
  AssetsCapability,
  CallOptions,
  ChatCapability,
  EventsCapability,
  MountPoint,
  NetCapability,
  PluginContext,
  ProviderCapability,
  SessionsCapability,
  SettingsCapability,
  StorageCapability,
  UiCapability,
} from './types.js'

/**
 * 单能力策略：时间窗内的调用上限，以及异步调用的单次超时。
 * 同步成员没有超时（同步调用不适用），这几项不填 timeoutMs：
 * sessions:rename、notify、plugins:storage，以及只给引擎用的 plugins:data-clear；
 * events:session 与 chat:request 是登记型成员，登记本身同步返回，同样不填。
 * 登记型成员的限流语义是「登记次数」：每次 events.on、每次 chat.onBeforeRequest 各占一个名额，
 * 之后的事件回调与请求前调用由引擎发起，不再占用名额。
 */
type Policy = { limit: number; windowMs: number; timeoutMs?: number }

const POLICIES: Record<CoreCapabilityId, Policy> = {
  'sessions:list': { limit: 30, windowMs: 10000, timeoutMs: 3000 },
  'sessions:read': { limit: 30, windowMs: 10000, timeoutMs: 3000 },
  'sessions:rename': { limit: 5, windowMs: 10000 },
  // 限制的是登记次数：每次 events.on 占一个名额，事件回调本身不再占用
  'events:session': { limit: 5, windowMs: 10000 },
  notify: { limit: 10, windowMs: 10000 },
  'settings:locale': { limit: 60, windowMs: 10000, timeoutMs: 3000 },
  // 内层 10 秒超时由 dsc-core 的 net:fetch 自己中止请求，这里只做外层兜底
  'net:fetch': { limit: 10, windowMs: 10000, timeoutMs: 12000 },
  // 内层 5 秒超时由 dsc-core 的计数请求自己中止，POST 与 GET 各用一个窗口，避免互相挤占
  'net:fetch-post': { limit: 10, windowMs: 10000, timeoutMs: 7000 },
  // 内层 10 秒超时由 dsc-core 的资产读取自己中止请求，这里只做外层兜底
  'assets:read': { limit: 20, windowMs: 10000, timeoutMs: 12000 },
  'plugins:storage': { limit: 100, windowMs: 10000 },
  // 卸载清理由引擎直接调用核心，不经过插件上下文，上限 0 表示插件不可达
  'plugins:data-clear': { limit: 0, windowMs: 10000 },
  // 限制的是登记次数；每次请求前调用处理器由引擎发起，不逐次占用名额
  'chat:request': { limit: 10, windowMs: 10000 },
  // 引擎启动时登记一次补丁来源，同样不经过插件上下文
  'chat:request-source': { limit: 0, windowMs: 10000 },
  // 限制的是声明次数: 每次 context.provider.registerSource 占一个名额, 不逐次执行。
  // 一个插件可能声明多条端点, 上限按 50 取; 声明集中在激活阶段, 超过上限会让整次激活失败并撤销全部声明。
  'provider:source': { limit: 50, windowMs: 10000 },
  // 按端点执行由引擎发起, 不经过插件上下文, 上限 0 表示插件不可达
  'source:run': { limit: 0, windowMs: 10000 },
}

/** 能力未授予 */
export class PluginCapabilityError extends Error {
  constructor(readonly capability: CoreCapabilityId) {
    super(`dsc-plugin-engine: capability ${capability} is not granted`)
    this.name = 'PluginCapabilityError'
  }
}

/** 调用超过限流阈值 */
export class PluginRateLimitError extends Error {
  constructor(readonly capability: CoreCapabilityId) {
    super(`dsc-plugin-engine: capability ${capability} is rate limited`)
    this.name = 'PluginRateLimitError'
  }
}

/** 调用超时 */
export class PluginTimeoutError extends Error {
  constructor(readonly capability: string) {
    super(`dsc-plugin-engine: ${capability} timed out`)
    this.name = 'PluginTimeoutError'
  }
}

/** 调用被取消 */
export class PluginAbortError extends Error {
  constructor(readonly capability: string) {
    super(`dsc-plugin-engine: ${capability} aborted`)
    this.name = 'PluginAbortError'
  }
}

/** 为任务加上超时与取消；超时或取消时任务结果被丢弃 */
export const runWithTimeout = async <T>(
  task: Promise<T>,
  timeoutMs: number,
  hooks: {
    onTimeout?: () => void
    signal?: AbortSignal
    abortError?: () => Error
    timeoutError?: () => Error
  } = {}
): Promise<T> => {
  const { onTimeout, signal, abortError, timeoutError } = hooks
  let timer = 0
  let abortHandler: (() => void) | null = null
  const guard = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => {
      onTimeout?.()
      reject(timeoutError ? timeoutError() : new Error('dsc-plugin-engine: task timed out'))
    }, timeoutMs)
    if (signal) {
      abortHandler = () => reject(abortError ? abortError() : new Error('dsc-plugin-engine: task aborted'))
      signal.addEventListener('abort', abortHandler, { once: true })
    }
  })
  void task.catch(() => undefined)
  try {
    return await Promise.race([task, guard])
  } finally {
    window.clearTimeout(timer)
    if (signal && abortHandler) {
      signal.removeEventListener('abort', abortHandler)
    }
  }
}

/** 构造插件上下文的依赖 */
export type ContextDeps = {
  record: PluginRecord
  core: CoreApi
  credential: CoreCredential
  report: (key: TranslationKey, params?: TranslationParams) => void
  /** 首次使用资产来源时的提示出口；由引擎按「插件 + 来源」去重后调用 */
  announceAsset: (pluginId: string, url: string) => void
  /** 登记一份端点声明；冲突由引擎记日志后原样返回，供上下文写插件日志 */
  declareSource: (pluginId: string, descriptor: CoreSourceDescriptor) => readonly SourceConflict[]
}

/** 把核心内部接口封装成受限能力对象 */
export const createPluginContext = ({
  record,
  core,
  credential,
  report,
  announceAsset,
  declareSource,
}: ContextDeps): PluginContext => {
  const { manifest } = record
  const windows = new Map<CoreCapabilityId, number[]>()

  /** 插件日志上限；上下文日志与引擎内部记录共用这一份实现 */
  const pushLog = (message: string) => {
    record.logs.push(message)
    if (record.logs.length > 100) {
      record.logs.shift()
    }
  }

  const ensureGranted = (capability: CoreCapabilityId) => {
    if (!manifest.capabilities.includes(capability)) {
      report('pluginCapabilityDenied', { id: manifest.id, capability })
      throw new PluginCapabilityError(capability)
    }
  }

  /** net:fetch 额外要求插件属于内置集合，第三方即使绕过清单也拿不到 */
  const ensureBuiltinOnly = (capability: CoreCapabilityId) => {
    if (!isBuiltinPlugin(manifest.id)) {
      report('pluginCapabilityDenied', { id: manifest.id, capability })
      throw new PluginCapabilityError(capability)
    }
  }

  /** 挂载点必须同时在清单里声明，缺声明与缺能力同样按未授权处理 */
  const ensureMount = (capability: CoreCapabilityId, point: MountPoint) => {
    if (!(manifest.mounts ?? []).includes(point)) {
      report('pluginCapabilityDenied', { id: manifest.id, capability })
      throw new PluginCapabilityError(capability)
    }
  }

  const takeToken = (capability: CoreCapabilityId) => {
    const policy = POLICIES[capability]
    const now = Date.now()
    const stamps = (windows.get(capability) ?? []).filter((stamp) => now - stamp < policy.windowMs)
    if (stamps.length >= policy.limit) {
      windows.set(capability, stamps)
      report('pluginCallRateLimited', { id: manifest.id, capability })
      throw new PluginRateLimitError(capability)
    }
    stamps.push(now)
    windows.set(capability, stamps)
  }

  const newCall = (capability: CoreCapabilityId): CoreCall => ({
    credential,
    ticket: issueTicket(capability),
  })

  const invoke = async <T>(
    capability: CoreCapabilityId,
    options: CallOptions | undefined,
    run: () => Promise<T>,
    hooks: { onTimeout?: () => void } = {}
  ): Promise<T> => {
    ensureGranted(capability)
    takeToken(capability)
    if (options?.signal?.aborted) {
      throw new PluginAbortError(capability)
    }
    const { timeoutMs } = POLICIES[capability]
    // 策略表没给超时的能力按同步成员处理，不包装超时；异步成员都在表里给出数值
    if (timeoutMs === undefined) {
      return await run()
    }
    return await runWithTimeout(run(), timeoutMs, {
      onTimeout:
        hooks.onTimeout ?? (() => report('pluginCallTimeout', { id: manifest.id, capability })),
      signal: options?.signal,
      abortError: () => new PluginAbortError(capability),
      timeoutError: () => new PluginTimeoutError(capability),
    })
  }

  const invokeSync = <T>(capability: CoreCapabilityId, run: () => T): T => {
    ensureGranted(capability)
    takeToken(capability)
    return run()
  }

  /** 插件数据失败按原因映射文案，再原样抛出 */
  const storageCall = <T>(run: () => T): T => {
    try {
      return run()
    } catch (error) {
      if (error instanceof PluginDataError) {
        report(
          error.reason === 'quota'
            ? 'pluginDataQuotaExceeded'
            : error.reason === 'storage'
              ? 'pluginDataUnavailable'
              : 'pluginDataInvalid',
          { id: manifest.id }
        )
      }
      throw error
    }
  }

  const sessions: SessionsCapability = {
    list: (options) =>
      invoke('sessions:list', options, () => core.listSessions(newCall('sessions:list'))),
    read: (id, options) =>
      invoke('sessions:read', options, () => core.readSession(newCall('sessions:read'), id)),
    rename: (id, title) =>
      invokeSync('sessions:rename', () => core.renameSession(newCall('sessions:rename'), id, title)),
  }

  const events: EventsCapability = {
    /**
     * 登记事件处理器；与 chat.onBeforeRequest 一样只登记、不逐次调用，
     * 因此每次 on 占用一次限流名额，事件分发不占用。
     */
    on: (point, handler) => {
      ensureGranted('events:session')
      ensureMount('events:session', point)
      takeToken('events:session')
      const handlers = record.mounts.get(point) ?? new Set()
      handlers.add(handler)
      record.mounts.set(point, handlers)
      const dispose = () => {
        handlers.delete(handler)
      }
      record.disposers.add(dispose)
      return dispose
    },
  }

  const chat: ChatCapability = {
    /**
     * 登记请求前处理器；与 events.on 一样只登记、不逐次调用，
     * 因此只在登记时占用一次限流名额。
     */
    onBeforeRequest: (handler) => {
      ensureGranted('chat:request')
      ensureMount('chat:request', 'chat:before-request')
      takeToken('chat:request')
      record.requestHandlers.add(handler)
      const dispose = () => {
        record.requestHandlers.delete(handler)
      }
      record.disposers.add(dispose)
      return dispose
    },
  }

  /**
   * 供应端点声明：只登记描述，不交执行代码。
   * 描述形态在引擎侧先校验一遍（含基址规范化），不合格的声明直接拒绝，不入注册表；
   * 同 id 定义不一致时后声明不生效，冲突写插件日志（引擎日志另记一份）。
   */
  const provider: ProviderCapability = {
    registerSource: (descriptor) => {
      ensureGranted('provider:source')
      takeToken('provider:source')
      const problem = checkSourceDescriptor(descriptor)
      const declaredId = typeof descriptor?.id === 'string' ? descriptor.id : ''
      if (problem !== null) {
        report('pluginSourceRejected', {
          id: manifest.id,
          source: declaredId === '' ? '(invalid id)' : declaredId,
          reason: problem,
        })
        throw new PluginSourceError(problem)
      }
      for (const conflict of declareSource(manifest.id, descriptor)) {
        pushLog(
          'provider:source: ' +
            conflict.sourceId +
            ' declared by ' +
            conflict.rejectedOwner +
            ' conflicts on ' +
            conflict.fields.join('/') +
            ', the definition from ' +
            conflict.keptOwner +
            ' stays effective until it is resolved'
        )
      }
    },
  }

  const ui: UiCapability = {
    notify: (key, params) => invokeSync('notify', () => core.notify(newCall('notify'), key, params)),
  }

  const settings: SettingsCapability = {
    locale: (options) =>
      invoke('settings:locale', options, async () =>
        core.currentLocale(newCall('settings:locale'))
      ),
  }

  const net: NetCapability = {
    getText: (url, options) =>
      invoke('net:fetch', options, async () => {
        ensureBuiltinOnly('net:fetch')
        // 网络与解析失败由插件自行降级，这里不弹宿主提示，避免离线时反复打扰
        return await core.fetchText(newCall('net:fetch'), url, options?.signal)
      }),
    postJson: (url, body, options) =>
      invoke('net:fetch-post', options, async () => {
        // POST 复用 net:fetch 的申请口径，插件清单仍只声明 net:fetch
        ensureGranted('net:fetch')
        ensureBuiltinOnly('net:fetch')
        return await core.postJson(newCall('net:fetch-post'), url, body, options?.signal)
      }),
  }

  /**
   * 资产读取的公共入口。
   * 首次使用某个来源地址时经 announceAsset 报告一次；之后的失败只写该插件的插件日志，不再打扰用户。
   * 三态结果原样返回；引擎侧能够确定的拒绝（地址、协议、体积、超时）按错误抛出。
   */
  const readAsset = async <T extends AssetTextResult | AssetBytesResult>(
    url: string,
    options: CallOptions | undefined,
    read: (signal?: AbortSignal) => Promise<T>
  ): Promise<T> =>
    invoke(
      'assets:read',
      options,
      async () => {
        announceAsset(manifest.id, url)
        try {
          const result = await read(options?.signal)
          if (result.kind === 'status') {
            pushLog('assets:read: status ' + String(result.status) + ' ' + result.url)
          } else if (result.kind === 'no-status') {
            pushLog('assets:read: no status from ' + result.url)
          }
          return result
        } catch (error) {
          pushLog(
            'assets:read: failed ' +
              (error instanceof Error ? error.message : String(error)) +
              ' ' +
              url
          )
          throw error
        }
      },
      { onTimeout: () => pushLog('assets:read: timed out ' + url) }
    )

  const assets: AssetsCapability = {
    readText: (url, options) =>
      readAsset(url, options, (signal) =>
        core.readAssetText(newCall('assets:read'), url, signal)
      ),
    readBytes: (url, options) =>
      readAsset(url, options, (signal) =>
        core.readAssetBytes(newCall('assets:read'), url, signal)
      ),
  }

  const storage: StorageCapability = {
    get: (key) =>
      invokeSync('plugins:storage', () =>
        storageCall(() => {
          const entry = core.readPluginEntry(newCall('plugins:storage'), manifest.id, key)
          return entry ? entry.value : null
        })
      ),
    set: (key, value) =>
      invokeSync('plugins:storage', () => {
        storageCall(() => {
          core.writePluginEntry(newCall('plugins:storage'), manifest.id, key, value)
        })
      }),
    remove: (key) =>
      invokeSync('plugins:storage', () => {
        storageCall(() => {
          core.removePluginEntry(newCall('plugins:storage'), manifest.id, key)
        })
      }),
  }

  return {
    id: manifest.id,
    version: manifest.version,
    sessions,
    events,
    ui,
    settings,
    net,
    assets,
    storage,
    chat,
    provider,
    log: pushLog,
  }
}
