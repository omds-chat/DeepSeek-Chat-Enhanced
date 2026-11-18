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

/**
 * 插件来源类型。
 * inner 随本体分发，awesome 来自精选合集，outer 来自其他在线来源，local 由用户上传。
 */
export type PluginSourceType = 'inner' | 'awesome' | 'outer' | 'local'

/** 插件签名校验状态；unverified 表示没有可校验的签名材料 */
export type SignatureState = 'verified' | 'unverified' | 'failed'

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

/** 计数请求结果；响应体被丢弃，只回传最终地址与状态码 */
export type NetPostResponse = {
  url: string
  status: number
}

/** 外源请求能力；GET 读文本，POST 只发一次 JSON 请求体且丢弃响应 */
export type NetCapability = {
  getText(url: string, options?: CallOptions): Promise<NetResponse>
  postJson(url: string, body: unknown, options?: CallOptions): Promise<NetPostResponse>
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

/** 插件产物导出形态：插件对象、工厂或 default 导出，三者都可附带具名 manifest 导出 */
export type PluginModule =
  | (DscPlugin & { manifest?: PluginManifest })
  | (PluginFactory & { manifest?: PluginManifest })
  | { default: DscPlugin | PluginFactory; manifest?: PluginManifest }

/** 从产物解析出的插件实例与产物自带的清单 */
export type LoadedPlugin = { plugin: DscPlugin; manifest?: PluginManifest }

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
  | 'signature-invalid'

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
  /** 来源类型；宿主直接注册的插件按 inner 处理 */
  sourceType: PluginSourceType
  /** 签名校验状态 */
  signatureVerified: SignatureState
  /** 用户期望的运行状态，落盘后用于下次启动恢复 */
  enabled: boolean
  /** 清单声明的依赖插件 id */
  dependencies: string[]
  capabilities: CoreCapabilityId[]
  contributions: ContributionPoint[]
  error?: string
}
