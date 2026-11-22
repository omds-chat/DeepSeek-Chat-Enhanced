import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import type {
  SlotActionHandler,
  SlotDataHandler,
  SlotDescriptorBody,
  SlotHandle,
  SlotName,
} from './pluginSlots.js'
import type {
  SettingDescriptor,
  SettingOverride,
  SettingsChangeHandler,
  SettingValue,
} from './pluginSettings.js'
import type { ProviderRunPayload, ProviderRunResult } from './providerRun.js'
import type {
  AssetBytesResult,
  AssetTextResult,
  CoreCapabilityId,
  CoreEvent,
  CoreSessionSummary,
  CoreSessionView,
  CoreSourceDescriptor,
  SourceCapabilityId,
} from '../dsc-core/index.js'
import type { PluginAsset } from './assetDownload.js'

/** 资产读取结果的两种形态；类型定义在 core，引擎原样转交给插件 */
export type { AssetBytesResult, AssetTextResult } from '../dsc-core/index.js'
/** 清单 assets 块的声明形态；校验与取件实现在 assetDownload.ts */
export type { PluginAsset } from './assetDownload.js'

/**
 * 单个插件的代码上限(字节)。
 * 代码文本要存进 IndexedDB,异常大的产物会挤占存储配额,在线安装与离线包共用这一上限。
 */
export const MAX_PLUGIN_CODE_BYTES = 2 * 1024 * 1024

/** 代码上限的 MB 数,供文案使用；由字节常量派生,调整上限只改上一处 */
export const MAX_PLUGIN_CODE_MB = MAX_PLUGIN_CODE_BYTES / (1024 * 1024)

/**
 * 挂载点；插件声明要挂到宿主哪个回调位置。
 * session:changed 是核心事件，chat:before-request 不是事件，它在每次发请求前同步调用一次。
 * ui:slot-action 与 ui:slot-data 服务插件 UI 槽位：前者在用户点击槽位页面动作按钮时回调，
 * 后者在宿主进入页面或收到刷新指示时索取页面模型，两者都是同步调用。
 */
export type MountPoint =
  | 'session:changed'
  | 'chat:before-request'
  | 'ui:slot-action'
  | 'ui:slot-data'

/** 全部挂载点 */
export const MOUNT_POINTS: readonly MountPoint[] = [
  'session:changed',
  'chat:before-request',
  'ui:slot-action',
  'ui:slot-data',
]

/** 事件处理器 */
export type MountHandler = (event: CoreEvent) => void

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
 * confirmed 表示合集证书链已在本地校验通过且 CMS 验签通过；
 * failed 表示校验未通过：证书链不通过（含过期、非本根签发、被吊销）,或拿不到证书、验签不通过；
 * unknown 表示完全没有来源信息；local 表示本地安装,不参与来源判定。
 * 信任清单的结论不参与这里的判定,只用于界面展示来源是否被官方认可。
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
  /**
   * 冲突的插件 id；安装期与启用期都生效。
   * 安装时该项已存在即拒绝；启用时该项正在运行也拒绝，且不会自动停用任何一方。
   */
  conflicts?: string[]
  /**
   * 申请的能力；必须在核心能力表内。
   * `net:fetch` 只对内置插件开放，`assets:read` 对全部插件开放。
   */
  capabilities: CoreCapabilityId[]
  /**
   * 挂载点；插件声明要挂到宿主哪个回调位置，取值必须在挂载点表内。
   * 由 meta.json 推导的安装清单可以缺该字段，安装阶段会用产物导出的 manifest 补齐。
   */
  mounts?: MountPoint[]
  /**
   * 申请的 UI 槽位；申请能力 ui:slot 后，只允许登记这里逐个声明的槽位，
   * 未声明的槽位登记时按未授权拒绝。由 meta.json 推导的安装清单可以缺该字段，
   * 安装阶段会用产物导出的 manifest 补齐。
   */
  slots?: SlotName[]
  /**
   * 声明的可下载资产；只在清单申请能力 assets:download 时允许出现。
   * 字段形状与逐条校验见 assetDownload.ts；地址与哈希由受信合集签名覆盖，
   * 引擎只按资产标识取件，不接受调用参数传地址。
   */
  assets?: PluginAsset[]
}

/** 会话能力 */
export type SessionsCapability = {
  list(options?: CallOptions): Promise<CoreSessionSummary[]>
  read(id: string, options?: CallOptions): Promise<CoreSessionView | null>
  rename(id: string, title: string): boolean
}

/** 事件能力 */
export type EventsCapability = {
  on(point: MountPoint, handler: MountHandler): () => void
}

/**
 * 提示与 UI 槽位能力。
 * notify 复用宿主文案键提示用户；registerSlot 登记一份声明式槽位描述，宿主据此渲染；
 * onSlotAction 与 onSlotData 分别登记槽位动作回调与槽位数据索取处理器，
 * 都要求清单声明对应槽位，登记返回释放函数，停用随引擎清理。
 */
export type UiCapability = {
  notify(key: TranslationKey, params?: TranslationParams): void
  /**
   * 登记一份插件 UI 槽位描述；与 settings.register 同法：只登记描述、不交控件，
   * 槽位不在枚举或未写入清单 slots 白名单、描述非法时抛 PluginSlotError，
   * code 是结构化的问题码。返回带槽位名与页面 id 的句柄，
   * 释放函数进入插件的 disposer 集合，停用随引擎清理。
   */
  registerSlot(slot: SlotName, descriptor: SlotDescriptorBody): SlotHandle
  /** 登记槽位动作回调；用户点击该槽位页面上的动作按钮时由引擎同步调用一次 */
  onSlotAction(slot: SlotName, handler: SlotActionHandler): () => void
  /** 登记槽位数据处理器；宿主进入页面或动作返回刷新指示时同步索取当前模型 */
  onSlotData(slot: SlotName, handler: SlotDataHandler): () => void
}

/**
 * 设置能力；locale 读宿主语言，register/values/overrides/onChange 走设置表面。
 * register 在激活期登记字段描述，返回释放函数，停用随引擎清理；
 * 描述非法时抛 PluginSettingsError，code 是结构化的问题码。
 * values 只读自身设置值：用户覆盖值优先，否则默认值；secret 字段不返回。
 * overrides 只读逐字段的覆盖状态：overridden 与宿主详情页「已修改」徽标同一口径，
 * secret 字段只回答是否已配置（secretConfigured），不返回值。
 * onChange 订阅设置变更，返回释放函数；回调由引擎在落盘后发起，不占插件限流名额，
 * 抛错只写该插件的插件日志，停用之后不再回调。
 * 写侧不在插件上下文，改动只由用户在宿主设置页保存。
 */
export type SettingsCapability = {
  locale(options?: CallOptions): Promise<'zh-CN' | 'en-US'>
  register(descriptor: SettingDescriptor): () => void
  values(): Record<string, SettingValue>
  overrides(): Promise<Record<string, SettingOverride>>
  onChange(handler: SettingsChangeHandler): () => void
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

/**
 * 资产读取能力；按地址取远端资产包的文本或字节。
 * 结果三态原样交给插件：取到内容、拿到明确 HTTP 状态码、只有网络层失败而无状态码。
 * 引擎不猜测失败原因，也不把状态码当异常抛出。
 * download 按资产标识发起一次引擎代取, 只认清单 assets 块里声明的标识,
 * 失败抛 PluginAssetDownloadError, reason 取失败码闭集之一, 取消为 aborted。
 */
export type AssetsCapability = {
  readText(url: string, options?: CallOptions): Promise<AssetTextResult>
  readBytes(url: string, options?: CallOptions): Promise<AssetBytesResult>
  download(assetId: string, options?: CallOptions): Promise<Uint8Array>
}

/** 插件数据能力；值必须可 JSON 序列化 */
export type StorageCapability = {
  get(key: string): unknown
  set(key: string, value: unknown): void
  remove(key: string): void
}

/** 请求前的只读切片；只给最后一条用户消息文本，不给整段会话 */
export type BeforeRequestPreview = { readonly lastUserMessage: string }

/**
 * 请求补丁；插件可返回的全部字段，全部可缺省。
 * 引擎按白名单收敛：未知字段丢弃，越界值按边界裁剪，超时或抛错时整份补丁作废。
 */
export type RequestPatch = {
  /** 0 到 2 */
  temperature?: number
  /** 0 到 1 */
  topP?: number
  /** 1 到 4096 的正整数 */
  maxTokens?: number
  /** 最多 4 条，每条最多 32 字符 */
  stop?: string[]
  /** 追加到系统提示词之后，最多 2000 字符 */
  systemPromptAppend?: string
  /** 整体替换系统提示词，最多 8000 字符 */
  systemPromptReplace?: string
}

/** 请求前处理器；返回补丁、null 或什么都不返回，三者都表示不改请求 */
export type BeforeRequestHandler = (
  preview: BeforeRequestPreview
) => RequestPatch | null | undefined

/** 请求前能力；登记处理器，返回释放函数 */
export type ChatCapability = {
  onBeforeRequest(handler: BeforeRequestHandler): () => void
}

/**
 * 供应端点能力；插件只交描述与载荷，不交执行代码。
 * 声明把端点登记进引擎的注册表；执行由引擎按注册表选中的端点读凭证、组描述后交给 dsc-core，
 * 插件既拿不到凭证，也拿不到请求对象。
 */
export type ProviderCapability = {
  /** 声明一个供应端点；同 id 定义不一致时该声明不生效，冲突记入引擎日志与注册表视图 */
  registerSource(descriptor: CoreSourceDescriptor): void
  /**
   * 按当前选中的端点执行一次能力调用；只有清单申请了 provider:run 才可用。
   * 本版只接通 text.generate 与 models.list，其余能力抛 PluginProviderRunError，码为 capability-unimplemented。
   * 失败一律抛错，不返回空结果：credential-missing、credential-stale、credential-rejected、
   * capability-unavailable、capability-unimplemented、endpoint-unreachable、protocol-error。
   */
  run(
    capability: SourceCapabilityId,
    payload: ProviderRunPayload,
    options?: CallOptions
  ): Promise<ProviderRunResult>
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
  readonly assets: AssetsCapability
  readonly storage: StorageCapability
  readonly chat: ChatCapability
  readonly provider: ProviderCapability
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

/** 安装拒绝原因；末尾几项只由本地离线包产生 */
export type InstallRejection =
  | 'invalid-manifest'
  | 'unknown-capability'
  | 'unknown-mount'
  /** 清单 slots 白名单里出现了槽位枚举之外的槽位名 */
  | 'unknown-slot'
  | 'incompatible-version'
  | 'duplicate'
  | 'missing-dependency'
  | 'conflict'
  | 'load-failed'
  /** 产物字节取不到：404、网络失败或被跨源策略拦住 */
  | 'artifact-unreachable'
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
  /** meta.json 无法解析，或缺少必填字段、版本号不是三段数字、dependencies.dsc 不是单段版本范围 */
  | 'invalid-meta'
  /** 插件代码超过单个插件上限 */
  | 'package-too-large'

/**
 * 安装结果。
 * 安装入口会自动启用插件，activation 记录这次启用的结论：启用被拒时安装本身仍然成功，
 * 界面据此避免用「安装完成」提示盖掉启用被拒的原因。
 * 冲突不再拒绝安装：安装期检出冲突时 ok 仍为 true，conflicts 带回全部冲突对
 * （kind、declarer、target）；引擎同时按对方的启用状态处置——与已启用插件冲突时新插件
 * 保持停用并写入待决定记录，此时 activation 缺省（没有发起启用）；
 * 只与已停用插件冲突时仅警告，插件照常自动启用。
 */
export type InstallResult =
  | { ok: true; activation?: ActivateResult; conflicts?: InstallConflict[] }
  | {
      ok: false
      reason: InstallRejection
      detail?: string
    }

/**
 * 启用期冲突描述。
 * single 表示只有一方在清单里声明排斥另一方；mutual 表示两边都声明了排斥对方。
 * declarer 是发起要求的一方，target 是被要求关闭的一方；mutual 时 declarer 取本次要启用的插件。
 */
export type ActivationConflict = {
  kind: 'single' | 'mutual'
  declarer: string
  target: string
}

/**
 * 安装期冲突描述，与启用期冲突同形。
 * declarer 是在清单里声明排斥对方的一方，target 是被排斥的一方；mutual 表示两边互相声明。
 * 安装期允许冲突共存：判定只负责检出（已安装记录不论启停都参与），
 * 处置看对方记录的启用状态；启用期的 activationConflicts 判的是「能否同时运行」，只看 active 的记录。
 */
export type InstallConflict = ActivationConflict

/** 启用拒绝原因；conflict 表示与正在运行的插件冲突 */
export type ActivateRejection =
  | 'not-installed'
  | 'no-plugin-instance'
  | 'missing-dependency'
  | 'conflict'
  | 'activate-failed'

/** 启用结果；冲突时必定带上全部冲突描述，界面按第一项提示 */
export type ActivateResult =
  | { ok: true }
  | {
      ok: false
      reason: 'conflict'
      detail: string
      conflicts: ActivationConflict[]
    }
  | {
      ok: false
      reason: Exclude<ActivateRejection, 'conflict'>
      detail?: string
    }

/** 停用选项；force 表示用户明确要求强行停用 */
export type DeactivateOptions = { force?: boolean }

/**
 * 停用结果。
 * depended-on 表示仍有处于启用状态的插件依赖它，停用被拒；dependents 列出这些插件。
 * 强制标志不改变结论：引擎不会连带停用依赖方，关联停用由用户自己完成。
 */
export type DeactivateResult =
  | { ok: true }
  | { ok: false; reason: 'not-active' }
  | { ok: false; reason: 'depended-on'; dependents: string[]; forced: boolean }

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
  /**
   * 目录数据是否已按三层清单校验通过。
   * 与 sourceVerdict 相互独立：目录未校验不影响产物结论，产物仍由 plugin.js.sig 验证；
   * 旧记录与本地安装没有该字段。
   */
  catalogVerified?: boolean
  /** 来源结论；local 表示本地安装,不参与来源判定 */
  sourceVerdict: SourceVerdict
  /** 来源结论的原因；只有 failed 有值 */
  sourceVerdictReason: SourceVerdictReason
  /** 信任清单给出的来源信任判定；旧记录没有该字段,只用于界面展示是否被官方认可 */
  sourceTrust?: SourceTrustState
  /** 信任清单给出的失败原因；缺失时界面按通用文案显示 */
  sourceTrustFailure?: SourceTrustFailure
  /** 安装记录没有任何一项校验字段,即旧版本安装；界面据此提示重新安装 */
  verificationMissing?: boolean
  /** 用户期望的运行状态，落盘后用于下次启动恢复 */
  enabled: boolean
  /** 清单声明的依赖插件 id */
  dependencies: string[]
  capabilities: CoreCapabilityId[]
  /** 清单声明的挂载点 */
  mounts: MountPoint[]
  /** 清单声明的 UI 槽位白名单 */
  slots: SlotName[]
  error?: string
}

/**
 * 待决定记录里的一对冲突，与启用期冲突同形。
 * single 只表达一个方向：declarer 在清单里声明排斥 target；mutual 表示两边都声明了排斥对方。
 */
export type PendingConflictPair = ActivationConflict

/**
 * 一次冲突检测留下的待决定记录。
 * 引擎检测到冲突时先把涉及的全部启用插件停用，再把整组冲突写成这条记录，
 * 由用户在插件面板选择保留哪一个；选择之前不自动启用任何一方。
 * 记录落在引擎自己的库里，不混进插件存储。
 */
export type PendingConflict = {
  /** 组 id：按字典序拼接涉及插件 id，同一组插件再次触发时覆盖同一条记录 */
  id: string
  /** 涉及的全部插件 id，按字典序；由冲突对推导，读回时重建 */
  plugins: string[]
  /** 全部冲突对，至少一对 */
  pairs: PendingConflictPair[]
  /** 检测时间（毫秒时间戳） */
  at: number
}

/** 用户对待决定冲突组做选择后的结论 */
export type ConflictDecisionResult =
  | { ok: true; kept: string; stopped: string[] }
  | {
      ok: false
      reason: ActivateRejection | 'not-found' | 'not-in-group'
      detail?: string
    }
