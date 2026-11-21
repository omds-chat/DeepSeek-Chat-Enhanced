import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import type { AssetBytesResult, AssetTextResult } from './assets.js'
import type { CoreCall } from './guard.js'
import type { CoreSourceRunRequest, CoreSourceRunResult } from './sources.js'

/** dsc-core 版本；与 package.json 的 version 保持一致 */
export const CORE_VERSION = '1.0.0'

/** 引擎可申请的核心能力 */
export type CoreCapabilityId =
  | 'sessions:list'
  | 'sessions:read'
  | 'sessions:rename'
  | 'events:session'
  | 'notify'
  | 'settings:locale'
  | 'net:fetch'
  // 资产读取对全部插件可见，与 net:fetch 的内置限定相互独立
  | 'assets:read'
  | 'plugins:storage'
  | 'chat:request'
  // 插件设置表面：激活期登记字段描述，宿主渲染表单；登记与校验都在引擎内完成
  | 'settings:surface'
  // 只声明供应端点，core 侧没有实现；登记与合并都在引擎内完成
  | 'provider:source'
  // 按选中的供应端点执行，core 侧没有独立方法；引擎组好描述与凭证后走 source:run
  | 'provider:run'
  // 引擎管理专用，不在 CORE_CAPABILITIES 内，插件申请时按未知能力拒绝
  | 'net:fetch-post'
  | 'plugins:data-clear'
  | 'chat:request-source'
  | 'source:run'

/** 全部核心能力；引擎据此校验插件申请 */
export const CORE_CAPABILITIES: readonly CoreCapabilityId[] = [
  'sessions:list',
  'sessions:read',
  'sessions:rename',
  'events:session',
  'notify',
  'settings:locale',
  'net:fetch',
  'assets:read',
  'plugins:storage',
  'chat:request',
  'settings:surface',
  'provider:source',
  'provider:run',
]

/** 会话摘要视图 */
export type CoreSessionSummary = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

/** 附件视图；不含本地 id、服务端 file_id 与原件 */
export type CoreAttachmentView = {
  name: string
  size: number
  isImage: boolean
}

/** 消息视图；只保留角色、文本与附件描述 */
export type CoreMessageView = {
  id: string
  role: 'user' | 'assistant'
  createdAt: number
  text: string
  attachments: CoreAttachmentView[]
}

/** 会话视图；不含分支结构与请求快照 */
export type CoreSessionView = CoreSessionSummary & { messages: CoreMessageView[] }

/** 核心向引擎广播的事件 */
export type CoreEvent = { type: 'session:changed'; activeId: string | null }

/** 外源请求结果 */
export type CoreFetchResult = {
  url: string
  contentType: string
  text: string
}

/** 计数请求结果；响应体被丢弃，只回传最终地址与状态码 */
export type CorePostResult = {
  url: string
  status: number
}

/** 资产文本读取结果；三态原样交给引擎，不做二次归类 */
export type CoreAssetTextResult = AssetTextResult

/** 资产字节读取结果；三态原样交给引擎，不做二次归类 */
export type CoreAssetBytesResult = AssetBytesResult

/** 请求前的只读切片；只给最后一条用户消息文本，不给整段会话 */
export type CoreRequestPreview = { readonly lastUserMessage: string }

/**
 * 请求补丁；字段由引擎收敛到白名单与范围内，core 只把它们写进请求。
 * 每个字段都可缺省，缺省表示不改这一项。
 */
export type CoreRequestPatch = {
  temperature?: number
  topP?: number
  maxTokens?: number
  stop?: string[]
  systemPromptAppend?: string
  systemPromptReplace?: string
}

/** 请求补丁来源；core 在发请求前同步调用一次，返回 null 表示不改请求 */
export type CoreRequestPatchSource = (preview: CoreRequestPreview) => CoreRequestPatch | null

/** 插件数据操作；三条能力共用 plugins:storage 服务 */
export type CoreStorageCall =
  | { op: 'read'; pluginId: string; key: string }
  | { op: 'write'; pluginId: string; key: string; value: unknown }
  | { op: 'remove'; pluginId: string; key: string }

/** 核心内部接口；每次调用都要带上引擎签发的 CoreCall */
export type CoreApi = {
  readonly version: string
  listSessions(call: CoreCall): Promise<CoreSessionSummary[]>
  readSession(call: CoreCall, id: string): Promise<CoreSessionView | null>
  renameSession(call: CoreCall, id: string, title: string): boolean
  currentLocale(call: CoreCall): 'zh-CN' | 'en-US'
  notify(call: CoreCall, key: TranslationKey, params?: TranslationParams): void
  subscribe(call: CoreCall, listener: (event: CoreEvent) => void): () => void
  fetchText(call: CoreCall, url: string, signal?: AbortSignal): Promise<CoreFetchResult>
  readAssetText(
    call: CoreCall,
    url: string,
    signal?: AbortSignal
  ): Promise<CoreAssetTextResult>
  readAssetBytes(
    call: CoreCall,
    url: string,
    signal?: AbortSignal
  ): Promise<CoreAssetBytesResult>
  postJson(
    call: CoreCall,
    url: string,
    body: unknown,
    signal?: AbortSignal
  ): Promise<CorePostResult>
  readPluginEntry(call: CoreCall, pluginId: string, key: string): { value: unknown } | null
  writePluginEntry(call: CoreCall, pluginId: string, key: string, value: unknown): void
  removePluginEntry(call: CoreCall, pluginId: string, key: string): void
  /** 清除单个插件的全部数据；只给引擎用于卸载清理 */
  clearPluginData(call: CoreCall, pluginId: string): void
  /** 登记请求补丁来源；只有引擎可以登记，传 null 撤销登记 */
  setRequestPatchSource(call: CoreCall, source: CoreRequestPatchSource | null): void
  /**
   * 按供应端点描述执行一次能力调用；只有引擎可以调用。
   * 描述与凭证都由引擎在执行时给出，插件侧拿不到这两项。
   */
  executeSource(call: CoreCall, request: CoreSourceRunRequest): Promise<CoreSourceRunResult>
}
