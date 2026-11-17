import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import type {
  CoreCapabilityId,
  CoreEvent,
  CoreSessionSummary,
  CoreSessionView,
} from '../dsc-core/index.js'

/** 贡献点；插件可订阅的核心事件 */
export type ContributionPoint = 'session:changed'

/** 全部贡献点 */
export const CONTRIBUTION_POINTS: readonly ContributionPoint[] = ['session:changed']

/** 事件处理器 */
export type ContributionHandler = (event: CoreEvent) => void

/** 调用选项 */
export type CallOptions = { signal?: AbortSignal }

/** 插件来源；内置或运行时地址，宿主直接注册的插件没有来源 */
export type PluginSource = { kind: 'builtin' } | { kind: 'url'; url: string }

/** 插件清单 */
export type PluginManifest = {
  /** 唯一标识；小写字母开头，可含数字与连字符 */
  id: string
  name: string
  version: string
  /** 兼容的 dsc-core 版本范围；支持 ^、~、>=、<= 与精确版本 */
  engines?: string
  /** 依赖的插件 id；安装时须已存在，激活时须已激活 */
  dependencies?: string[]
  /** 冲突的插件 id；同时安装会被拒绝 */
  conflicts?: string[]
  /** 申请的能力；必须在核心能力表内 */
  capabilities: CoreCapabilityId[]
  /** 订阅的贡献点；必须在贡献点表内 */
  contributions?: ContributionPoint[]
}

/** 会话能力 */
export type SessionsCapability = {
  list(options?: CallOptions): Promise<CoreSessionSummary[]>
  read(id: string, options?: CallOptions): Promise<CoreSessionView | null>
  rename(id: string, title: string): boolean
}

/** 事件能力 */
export type EventsCapability = {
  on(point: ContributionPoint, handler: ContributionHandler): () => void
}

/** 提示能力 */
export type UiCapability = {
  notify(key: TranslationKey, params?: TranslationParams): void
}

/** 设置能力 */
export type SettingsCapability = {
  locale(options?: CallOptions): Promise<'zh-CN' | 'en-US'>
}

/** 外源请求结果；只有文本与最终地址 */
export type NetResponse = {
  url: string
  contentType: string
  text: string
}

/** 外源请求能力；只支持 https 的 GET 文本请求 */
export type NetCapability = {
  getText(url: string, options?: CallOptions): Promise<NetResponse>
}

/** 插件数据能力；值必须可 JSON 序列化 */
export type StorageCapability = {
  get(key: string): unknown
  set(key: string, value: unknown): void
  remove(key: string): void
}

/** 插件上下文；能力对象由引擎封装 */
export type PluginContext = {
  readonly id: string
  readonly version: string
  readonly sessions: SessionsCapability
  readonly events: EventsCapability
  readonly ui: UiCapability
  readonly settings: SettingsCapability
  readonly net: NetCapability
  readonly storage: StorageCapability
  readonly log: (message: string) => void
}

/** 插件契约 */
export type DscPlugin = {
  activate(context: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}

/** 插件工厂 */
export type PluginFactory = () => DscPlugin | Promise<DscPlugin>

/** 插件产物导出形态 */
export type PluginModule = DscPlugin | PluginFactory | { default: DscPlugin | PluginFactory }

/** 插件状态 */
export type PluginState = 'registered' | 'active' | 'inactive' | 'failed'

/** 安装拒绝原因 */
export type InstallRejection =
  | 'invalid-manifest'
  | 'unknown-capability'
  | 'unknown-contribution'
  | 'incompatible-version'
  | 'duplicate'
  | 'missing-dependency'
  | 'conflict'
  | 'load-failed'
  | 'invalid-plugin'

/** 安装结果 */
export type InstallResult = { ok: true } | { ok: false; reason: InstallRejection; detail?: string }

/** 插件状态视图 */
export type PluginStateView = {
  id: string
  name: string
  version: string
  state: PluginState
  /** 恢复来源；宿主直接注册的插件为 null */
  source: PluginSource | null
  /** 用户期望的运行状态，落盘后用于下次启动恢复 */
  enabled: boolean
  capabilities: CoreCapabilityId[]
  contributions: ContributionPoint[]
  error?: string
}
