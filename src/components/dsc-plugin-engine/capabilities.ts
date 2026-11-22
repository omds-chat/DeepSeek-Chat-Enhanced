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
import { isTranslationKey } from '../../i18n/index.js'
import { sourceEndpointPolicy } from '../../services/settings.js'
import {
  PluginSettingsError,
  checkSettingDescriptor,
  declareSettings,
  forgetSettings,
  pluginSettingOverridesForPlugin,
  pluginSettingValuesForPlugin,
  subscribeSettingsChange,
} from './pluginSettings.js'
import { readSourceCredential } from './credentials.js'
import {
  PluginSlotError,
  canClaimSlotId,
  checkSlotDescriptor,
  declareSlot,
  declareSlotActionHandler,
  declareSlotDataHandler,
  forgetSlot,
  forgetSlotActionHandler,
  forgetSlotDataHandler,
  type SlotName,
} from './pluginSlots.js'
import { runProviderCapability, type ProviderRunDeps } from './providerRun.js'
import { isBuiltinPlugin, type PluginRecord } from './registry.js'
import { PluginSourceError, selectedSource, type SourceConflict } from './sources.js'
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
 * settings:surface 只给它的异步成员 overrides 用超时，登记与读值都是同步成员，不受影响。
 * 登记型成员的限流语义是「登记次数」：每次 events.on、每次 chat.onBeforeRequest、
 * 每次 settings.onChange 各占一个名额，之后的事件回调、请求前调用与设置变更回调由引擎发起，不再占用名额。
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
  // 内层 10 秒超时由 dsc-core 的资产读取自己中止请求，这里只做外层兜底。
  // 装一个资产包要逐个取版本目录里的文件，几十次读取是正常用量，上限按此放宽。
  'assets:read': { limit: 120, windowMs: 10000, timeoutMs: 12000 },
  'plugins:storage': { limit: 100, windowMs: 10000 },
  // 卸载清理由引擎直接调用核心，不经过插件上下文，上限 0 表示插件不可达
  'plugins:data-clear': { limit: 0, windowMs: 10000 },
  // 限制的是登记次数；每次请求前调用处理器由引擎发起，不逐次占用名额
  'chat:request': { limit: 10, windowMs: 10000 },
  // 登记与读取共用一个窗口：每次 settings.register 占一个名额，settings.values、
  // settings.overrides 的读取与 settings.onChange 的登记同样计数；超时只对异步成员 overrides 生效
  'settings:surface': { limit: 60, windowMs: 10000, timeoutMs: 3000 },
  // 登记型成员：registerSlot、onSlotAction 与 onSlotData 各占一个名额，
  // 槽位动作回调与页面数据索取由引擎发起，不再占用名额
  'ui:slot': { limit: 20, windowMs: 10000 },
  // 引擎启动时登记一次补丁来源，同样不经过插件上下文
  'chat:request-source': { limit: 0, windowMs: 10000 },
  // 限制的是声明次数: 每次 context.provider.registerSource 占一个名额, 不逐次执行。
  // 一个插件可能声明多条端点, 上限按 50 取; 声明集中在激活阶段, 超过上限会让整次激活失败并撤销全部声明。
  'provider:source': { limit: 50, windowMs: 10000 },
  // 执行按调用次数计: 选端点、读凭证与组装请求都在这一次调用内完成。
  // 超时只兜住「建立调用」这一段; text.generate 的回流事件在调用返回后惰性产出, 不占这个时间预算。
  'provider:run': { limit: 10, windowMs: 10000, timeoutMs: 15000 },
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

  /**
   * UI 槽位必须写入清单 slots 白名单。
   * 与挂载点同法：白名单是逐位置的授权，能力 ui:slot 只回答「能不能登记槽位」，
   * 「能登记哪些槽位」由清单 slots 决定；未声明的槽位登记时按未授权拒绝。
   */
  const ensureSlotGranted = (slot: SlotName) => {
    if (!(manifest.slots ?? []).includes(slot)) {
      report('pluginSlotNotGranted', { id: manifest.id, slot })
      throw new PluginSlotError('slot-not-granted')
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

  /**
   * 按端点执行的三个依赖。
   * 端点选择只看注册表, 与凭证是否已填无关: 缺凭证时按 credential-missing 报错, 而不是悄悄换到下一个端点;
   * 执行仍签 source:run 票据, 凭证由引擎在这一步读出, 插件侧拿不到。
   */
  const providerDeps: ProviderRunDeps = {
    selectedSource,
    // 凭证与端点基址绑定, 基址的放行策略与声明期同源, 否则开关打开后仍读不到局域网端点的 Key
    readCredential: (sourceId, baseUrl) =>
      readSourceCredential(sourceId, baseUrl, sourceEndpointPolicy()),
    execute: (request) => core.executeSource(newCall('source:run'), request),
  }

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
    run: (capability, payload, options) =>
      invoke('provider:run', options, () =>
        runProviderCapability(providerDeps, capability, payload, { signal: options?.signal })
      ),
    registerSource: (descriptor) => {
      ensureGranted('provider:source')
      takeToken('provider:source')
      const problem = checkSourceDescriptor(descriptor, sourceEndpointPolicy())
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
    /**
     * 登记插件 UI 槽位。与 settings.register 同法: 只登记描述、不交控件,
     * 校验即拒绝(槽位不在枚举、非法 id、非法文案、非法区块都让整份注册失败),
     * 授权按清单 slots 白名单逐槽位判定; 同槽位同 id 被其他插件占用时同样拒绝。
     * 释放函数进入插件的 disposer 集合, 停用随引擎清理。
     */
    registerSlot: (slot, descriptor) => {
      ensureGranted('ui:slot')
      takeToken('ui:slot')
      const check = checkSlotDescriptor({ ...descriptor, slot }, isTranslationKey)
      if (!check.ok) {
        report('pluginSlotRejected', { id: manifest.id, reason: check.problem })
        throw new PluginSlotError(check.problem)
      }
      ensureSlotGranted(check.descriptor.slot)
      if (!canClaimSlotId(check.descriptor.slot, check.descriptor.id, manifest.id)) {
        report('pluginSlotRejected', { id: manifest.id, reason: 'duplicate-id' })
        throw new PluginSlotError('duplicate-id')
      }
      declareSlot(manifest.id, check.descriptor)
      const dispose = () => {
        forgetSlot(manifest.id, check.descriptor.slot, check.descriptor.id)
      }
      record.disposers.add(dispose)
      return { slot: check.descriptor.slot, id: check.descriptor.id, dispose }
    },
    /**
     * 登记槽位动作回调。与 events.on 同法: 只登记、不逐次调用,
     * 用户点击动作按钮时由引擎同步回调, 每次登记占一个限流名额。
     * 授权按清单 slots 白名单判定, 不再看挂载点声明。
     */
    onSlotAction: (slot, handler) => {
      ensureGranted('ui:slot')
      ensureSlotGranted(slot)
      takeToken('ui:slot')
      declareSlotActionHandler(manifest.id, handler)
      const dispose = () => {
        forgetSlotActionHandler(manifest.id)
      }
      record.disposers.add(dispose)
      return dispose
    },
    /**
     * 登记槽位数据处理器。宿主进入页面或动作返回刷新指示时同步索取当前模型,
     * 登记口径与槽位动作回调相同。
     */
    onSlotData: (slot, handler) => {
      ensureGranted('ui:slot')
      ensureSlotGranted(slot)
      takeToken('ui:slot')
      declareSlotDataHandler(manifest.id, handler)
      const dispose = () => {
        forgetSlotDataHandler(manifest.id)
      }
      record.disposers.add(dispose)
      return dispose
    },
  }

  const settings: SettingsCapability = {
    locale: (options) =>
      invoke('settings:locale', options, async () =>
        core.currentLocale(newCall('settings:locale'))
      ),
    /**
     * 登记设置表面描述。与 provider.registerSource 同法: 只登记描述、不交控件,
     * 校验即拒绝(重复 key、未知类型、非法 default 都让整份注册失败),
     * 释放函数进入插件的 disposer 集合, 停用随引擎清理。
     */
    register: (descriptor) =>
      invokeSync('settings:surface', () => {
        const check = checkSettingDescriptor(descriptor, isTranslationKey)
        if (!check.ok) {
          report('pluginSettingsRejected', { id: manifest.id, reason: check.problem })
          throw new PluginSettingsError(check.problem)
        }
        declareSettings(manifest.id, check.descriptor)
        const dispose = () => {
          forgetSettings(manifest.id)
        }
        record.disposers.add(dispose)
        return dispose
      }),
    // 只读自身命名空间: 其他插件的设置值不可见, secret 字段不返回
    values: () => invokeSync('settings:surface', () => pluginSettingValuesForPlugin(manifest.id)),
    /**
     * 只读自身的覆盖状态; 与 values 共用 settings:surface 的读取窗口。
     * secret 字段要看「是否已配置」, 要等一次凭证库查询, 因此这个成员是异步的。
     */
    overrides: () =>
      invoke('settings:surface', undefined, () => pluginSettingOverridesForPlugin(manifest.id)),
    /**
     * 订阅设置变更。与 register 同法: 登记时占一个限流名额, 之后由引擎在
     * 每次落盘后回调, 不占名额; 释放函数进入 disposer 集合, 停用随引擎清理。
     * 回调抛错由引擎捕获并写插件日志, 不影响其他订阅者。
     */
    onChange: (handler) =>
      invokeSync('settings:surface', () => {
        const dispose = subscribeSettingsChange(manifest.id, handler, pushLog)
        record.disposers.add(dispose)
        return dispose
      }),
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
