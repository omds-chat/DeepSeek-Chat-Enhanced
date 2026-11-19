import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import type {
  CoreCapabilityId,
  CoreEvent,
  CoreSessionSummary,
  CoreSessionView,
} from '../dsc-core/index.js'

/**
 * 单个插件的代码上限(字节)。
 * 代码文本要存进 IndexedDB,异常大的产物会挤占存储配额,在线安装与离线包共用这一上限。
 */
export const MAX_PLUGIN_CODE_BYTES = 1024 * 1024

/** 贡献点；插件可订阅的核心事件 */
export type ContributionPoint = 'session:changed'

/** 全部贡献点 */
export const CONTRIBUTION_POINTS: readonly ContributionPoint[] = ['session:changed']

/** 事件处理器 */
export type ContributionHandler = (event: CoreEvent) => void

/** 调用选项 */
export type CallOptions = { signal?: AbortSignal }

/**
 * 插件来源；内置、运行时地址或本地离线包。
 * 宿主直接注册的插件没有来源，local 没有可重新拉取的地址。
 */
export type PluginSource =
  | { kind: 'builtin' }
  | { kind: 'url'; url: string }
  | { kind: 'local' }

/**
 * 插件来源类型。
 * inner 随本体分发，awesome 来自精选合集，outer 来自其他在线来源，local 由用户上传。
 */
export type PluginSourceType = 'inner' | 'awesome' | 'outer' | 'local'

/** 插件签名校验状态；unverified 表示没有可校验的签名材料 */
export type SignatureState = 'verified' | 'unverified' | 'failed'

/**
 * 来源结论。
 * confirmed 表示验签证书来自 online-data 信任清单且合集 CMS 验签通过；
 * failed 表示校验未通过：证书来自清单但验签未通过,或来源在清单里但证书链校验失败、证书已被吊销；
 * unknown 表示清单里没有该来源,无法确认；local 表示本地安装,不参与来源判定。
 */
export type SourceVerdict = 'confirmed' | 'failed' | 'unknown' | 'local'

/** 来源结论的原因；只有 failed 有值,其余为 null */
export type SourceVerdictReason = 'chain' | 'revoked' | 'other' | null

/** 来源信任判定；与插件市场的来源信任状态取值一致 */
export type SourceTrustState = 'trusted' | 'endorsed' | 'untrusted' | 'unverified'

/** 信任失败原因；missing 表示清单登记或证书文件缺失 */
export type SourceTrustFailure = 'missing' | 'chain' | 'revoked'

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

/** 安装拒绝原因；后五项只由本地离线包产生 */
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
  /** 扩展名不是 .zip 或 .tgz */
  | 'unsupported-package'
  /** 压缩包无法解压，或包内文件不是合法文本 */
  | 'corrupt-package'
  /** 离线包内缺少 meta.json */
  | 'missing-meta'
  /** 离线包内缺少 plugin.js */
  | 'missing-plugin'
  /** meta.json 无法解析，或缺少必填字段、版本号不是三段数字 */
  | 'invalid-meta'
  /** 插件代码超过单个插件上限 */
  | 'package-too-large'

/** 安装结果 */
export type InstallResult = { ok: true } | { ok: false; reason: InstallRejection; detail?: string }

/** 双语文本；缺失的一侧用另一侧补 */
export type LocalizedText = { 'zh-CN': string; 'en-US': string }

/** 离线包待安装信息；只用于二次确认，不进入安装记录 */
export type LocalPackageInfo = {
  /** 由 meta.json 的 name 推导，与市场使用同一条规则 */
  id: string
  name: string
  version: string
  author: string
  /** 缺失时为空串，由界面显示占位文案 */
  license: string
  description: LocalizedText
  /** 包内签名材料齐全且校验通过为 verified；材料齐全但校验不通过为 failed；无材料为 unverified */
  signatureVerified: SignatureState
  /** 已存在同 id 的安装记录 */
  installed: boolean
}

/**
 * 离线包预检结果。
 * 通过时返回待安装信息与提交函数：确认在界面层完成，提交前不改动任何状态。
 */
export type LocalPackageInspection =
  | { ok: true; info: LocalPackageInfo; commit: () => Promise<InstallResult> }
  | { ok: false; reason: InstallRejection; detail?: string }

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
  /** 在线插件的版本目录地址，来自安装记录；旧记录没有该字段 */
  dataBase?: string
  /** 来源结论；local 表示本地安装,不参与来源判定 */
  sourceVerdict: SourceVerdict
  /** 来源结论的原因；只有 failed 有值 */
  sourceVerdictReason: SourceVerdictReason
  /** 用户期望的运行状态，落盘后用于下次启动恢复 */
  enabled: boolean
  /** 清单声明的依赖插件 id */
  dependencies: string[]
  capabilities: CoreCapabilityId[]
  contributions: ContributionPoint[]
  error?: string
}
