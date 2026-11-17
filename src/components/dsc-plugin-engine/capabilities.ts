import {
  PluginDataError,
  issueTicket,
  type CoreApi,
  type CoreCall,
  type CoreCapabilityId,
  type CoreCredential,
} from '../dsc-core/index.js'
import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import { isBuiltinPlugin, type PluginRecord } from './registry.js'
import type {
  CallOptions,
  EventsCapability,
  NetCapability,
  PluginContext,
  SessionsCapability,
  SettingsCapability,
  StorageCapability,
  UiCapability,
} from './types.js'

/** 单能力策略：时间窗内的调用上限与单次超时 */
type Policy = { limit: number; windowMs: number; timeoutMs: number }

const POLICIES: Record<CoreCapabilityId, Policy> = {
  'sessions:list': { limit: 30, windowMs: 10000, timeoutMs: 3000 },
  'sessions:read': { limit: 30, windowMs: 10000, timeoutMs: 3000 },
  'sessions:rename': { limit: 5, windowMs: 10000, timeoutMs: 3000 },
  'events:session': { limit: 5, windowMs: 10000, timeoutMs: 3000 },
  notify: { limit: 10, windowMs: 10000, timeoutMs: 3000 },
  'settings:locale': { limit: 60, windowMs: 10000, timeoutMs: 3000 },
  // 内层 10 秒超时由 dsc-core 的 net:fetch 自己中止请求，这里只做外层兜底
  'net:fetch': { limit: 10, windowMs: 10000, timeoutMs: 12000 },
  'plugins:storage': { limit: 100, windowMs: 10000, timeoutMs: 3000 },
  // 卸载清理由引擎直接调用核心，不经过插件上下文，上限 0 表示插件不可达
  'plugins:data-clear': { limit: 0, windowMs: 10000, timeoutMs: 3000 },
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
}

/** 把核心内部接口封装成受限能力对象 */
export const createPluginContext = ({
  record,
  core,
  credential,
  report,
}: ContextDeps): PluginContext => {
  const { manifest } = record
  const windows = new Map<CoreCapabilityId, number[]>()

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
    run: () => Promise<T>
  ): Promise<T> => {
    ensureGranted(capability)
    takeToken(capability)
    if (options?.signal?.aborted) {
      throw new PluginAbortError(capability)
    }
    return await runWithTimeout(run(), POLICIES[capability].timeoutMs, {
      onTimeout: () => report('pluginCallTimeout', { id: manifest.id, capability }),
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
    on: (point, handler) => {
      ensureGranted('events:session')
      if (!(manifest.contributions ?? []).includes(point)) {
        report('pluginCapabilityDenied', { id: manifest.id, capability: 'events:session' })
        throw new PluginCapabilityError('events:session')
      }
      const handlers = record.contributions.get(point) ?? new Set()
      handlers.add(handler)
      record.contributions.set(point, handlers)
      const dispose = () => {
        handlers.delete(handler)
      }
      record.disposers.add(dispose)
      return dispose
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
    storage,
    log: (message) => {
      record.logs.push(message)
      if (record.logs.length > 100) {
        record.logs.shift()
      }
    },
  }
}
