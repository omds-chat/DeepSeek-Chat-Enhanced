import { isHttpsOrLocalUrl, type HttpEndpointPolicy } from '../../utils/url.js'

/**
 * 供应端点的能力标识表与描述形态约束。
 * 这里的"来源"指插件声明供宿主调用的模型端点(provider endpoint), 不是插件安装来源(inner、outer 等),
 * 文档与界面统一称"供应端点", 避免与市场的"来源"混用。
 * core 按能力维度执行, 不认识厂商: 能力标识说明"要做哪一类事情",
 * 描述里的 format 决定这一类事情怎么落成线上请求。
 * 本文件只依赖纯工具函数, 引擎注册表与内存夹具可以直接引用, 不会带出 store、网络层与界面。
 */

/** 能力标识; core 只按这些标识分派, 不按厂商分派 */
export type SourceCapabilityId =
  /** 文本生成: 组装一轮对话请求并解析流式回流 */
  | 'text.generate'
  /** 思考过程: 只取思考增量, 与正文分开回流 */
  | 'reasoning.think'
  /** 图像理解: 图片输入与文本回流 */
  | 'vision.image'
  /** 文档解析: 文档输入转文本 */
  | 'document.read'
  /** 语音识别: 音频转文本 */
  | 'audio.asr'
  /** 语音合成: 文本转音频 */
  | 'audio.tts'
  /** 联网搜索: 一次查询与结果条目 */
  | 'tool.web-search'
  /** 阅读链接: 按地址取回正文 */
  | 'tool.read-url'
  /** 模型清单: 列出该供应端点可用的模型 */
  | 'models.list'

/** 能力标识常量表; 使用常量而不是散落的字面量, 便于按表检索与后续改名 */
export const SOURCE_CAPABILITIES = {
  textGenerate: 'text.generate',
  reasoningThink: 'reasoning.think',
  visionImage: 'vision.image',
  documentRead: 'document.read',
  audioAsr: 'audio.asr',
  audioTts: 'audio.tts',
  toolWebSearch: 'tool.web-search',
  toolReadUrl: 'tool.read-url',
  modelsList: 'models.list',
} as const satisfies Record<string, SourceCapabilityId>

/** 全部能力标识; 能力矩阵按这个顺序逐项展开 */
export const SOURCE_CAPABILITY_IDS: readonly SourceCapabilityId[] = [
  SOURCE_CAPABILITIES.textGenerate,
  SOURCE_CAPABILITIES.reasoningThink,
  SOURCE_CAPABILITIES.visionImage,
  SOURCE_CAPABILITIES.documentRead,
  SOURCE_CAPABILITIES.audioAsr,
  SOURCE_CAPABILITIES.audioTts,
  SOURCE_CAPABILITIES.toolWebSearch,
  SOURCE_CAPABILITIES.toolReadUrl,
  SOURCE_CAPABILITIES.modelsList,
]

/**
 * 已落地的能力; 其余能力目前只有标识与载荷形态, 执行时按 unsupported 拒绝。
 * 这张表只用于说明现状, 不参与分派: 分派仍由入口里的能力分支决定。
 */
export const IMPLEMENTED_SOURCE_CAPABILITIES: readonly SourceCapabilityId[] = [
  SOURCE_CAPABILITIES.textGenerate,
  SOURCE_CAPABILITIES.modelsList,
]

/** 线上协议格式; 只描述协议, 不指厂商 */
export type SourceFormat = 'anthropic-messages' | 'openai-chat'

/** 全部协议格式 */
export const SOURCE_FORMATS: readonly SourceFormat[] = ['anthropic-messages', 'openai-chat']

/** 能力标识判定 */
export const isSourceCapabilityId = (value: unknown): value is SourceCapabilityId =>
  typeof value === 'string' && (SOURCE_CAPABILITY_IDS as readonly string[]).includes(value)

/** 协议格式判定 */
export const isSourceFormat = (value: unknown): value is SourceFormat =>
  typeof value === 'string' && (SOURCE_FORMATS as readonly string[]).includes(value)

/** 供应端点 id 规则: 小写字母开头, 允许数字、点、下划线与连字符, 3 到 64 字符 */
export const SOURCE_ID_PATTERN = /^[a-z][a-z0-9._-]{2,63}$/

/** 供应端点 id 判定 */
export const isSourceId = (value: unknown): value is string =>
  typeof value === 'string' && SOURCE_ID_PATTERN.test(value)

/** 目前有端点定义的能力; 其余能力的端点形态随能力一起待定 */
export type SourceEndpointCapability = 'text.generate' | 'models.list'

/** 各 format 的默认端点路径 */
const FORMAT_PATHS: Record<SourceFormat, Record<SourceEndpointCapability, string>> = {
  'anthropic-messages': {
    'text.generate': '/anthropic/v1/messages',
    'models.list': '/models',
  },
  'openai-chat': {
    'text.generate': '/v1/chat/completions',
    'models.list': '/v1/models',
  },
}

/** 供宿主编排的端点覆盖; 键是能力标识, 值是站内绝对路径 */
export type SourceEndpointOverrides = Partial<Record<SourceCapabilityId, string>>

/**
 * 供应端点描述; 插件只交这一份描述, 不交执行代码。
 * core 按 format 决定请求与回流的解析方式, 按 capabilities 决定哪些能力可以在这条供应端点上执行。
 */
export type CoreSourceDescriptor = {
  /** 供应端点 id; 注册表按它判重与合并, 冲突也按它判定 */
  readonly id: string
  /** 展示名称; 只用于界面展示, 不参与冲突判定 */
  readonly label: string
  /** 线上协议格式 */
  readonly format: SourceFormat
  /**
   * 规范化后的端点基址, 例如 https://api.deepseek.com。
   * 默认只允许 https 与本机回环的 http; 宿主的局域网开关打开后, 其它主机的 http 也接受。
   */
  readonly baseUrl: string
  /** 该供应端点可提供的能力清单; 注册表按并集合并, 执行前再校验一次 */
  readonly capabilities: readonly SourceCapabilityId[]
  /** 端点路径覆盖; 缺省按 format 推导, 只允许站内绝对路径 */
  readonly endpoints?: SourceEndpointOverrides
}

/** 拼出某个能力在某个供应端点上的绝对地址; 基址末尾的斜杠不影响结果 */
export const sourceEndpoint = (
  source: CoreSourceDescriptor,
  capability: SourceEndpointCapability
): string => {
  const base = source.baseUrl.trim().replace(/\/+$/, '')
  const suffix = source.endpoints?.[capability] ?? FORMAT_PATHS[source.format][capability]
  return base + (suffix.startsWith('/') ? suffix : '/' + suffix)
}

/** 供应端点描述被拒绝的字段; 引擎按它给出可读原因 */
export type SourceProblem = 'id' | 'label' | 'format' | 'baseUrl' | 'capabilities' | 'endpoints'

/** 展示名上限 */
const MAX_LABEL_LENGTH = 40

/**
 * 规范化端点基址。
 * 规则: 去首尾空白、主机转小写、去默认端口、去尾斜杠; 带 query、hash 或内嵌用户名密码的地址直接拒绝。
 * 协议与主机按 policy 判定: 缺省为 https 加本机回环 http, allowLanHttp 打开后额外放行局域网 http。
 * 注册表的定义比对与执行期的地址拼接都只用规范化后的值, 两处看到同一个字符串。
 */
export const normalizeSourceBaseUrl = (
  value: unknown,
  policy?: HttpEndpointPolicy
): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (trimmed === '' || !isHttpsOrLocalUrl(trimmed, policy)) {
    return null
  }
  let target: URL
  try {
    target = new URL(trimmed)
  } catch {
    return null
  }
  // URL 解析已把主机转成小写并去掉默认端口
  if (target.search !== '' || target.hash !== '') {
    return null
  }
  if (target.username !== '' || target.password !== '') {
    return null
  }
  return target.origin + target.pathname.replace(/\/+$/, '')
}

/** 读取能力清单; 空数组、非字符串项与未知标识都判为不合法 */
const readCapabilities = (value: unknown): SourceCapabilityId[] | null => {
  if (!Array.isArray(value) || value.length === 0) {
    return null
  }
  const ids: SourceCapabilityId[] = []
  for (const item of value) {
    if (!isSourceCapabilityId(item)) {
      return null
    }
    ids.push(item)
  }
  return ids
}

/** 端点覆盖必须是站内绝对路径, 不允许写成完整地址指向别的供应端点 */
const isEndpointPath = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().startsWith('/') && !value.includes('://')

const isEndpointMap = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  for (const [key, path] of Object.entries(value)) {
    if (!isSourceCapabilityId(key) || !isEndpointPath(path)) {
      return false
    }
  }
  return true
}

/** 端点路径规范化: 去空白与尾斜杠, 空路径回落为根路径 */
const normalizeEndpointPath = (path: string): string => {
  const cut = path.trim().replace(/\/+$/, '')
  return cut === '' ? '/' : cut
}

const normalizeEndpoints = (endpoints: SourceEndpointOverrides): SourceEndpointOverrides => {
  const next: SourceEndpointOverrides = {}
  for (const [key, path] of Object.entries(endpoints)) {
    if (isSourceCapabilityId(key) && typeof path === 'string') {
      next[key] = normalizeEndpointPath(path)
    }
  }
  return next
}

/**
 * 检查一份供应端点描述。
 * 只做形态与取值判定, 不做注册表层面的合并与冲突判断, 冲突由引擎的注册表判定。
 */
export const checkSourceDescriptor = (
  value: unknown,
  policy?: HttpEndpointPolicy
): SourceProblem | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'id'
  }
  const raw = value as Record<string, unknown>
  if (!isSourceId(raw.id)) {
    return 'id'
  }
  if (typeof raw.label !== 'string' || raw.label.trim() === '') {
    return 'label'
  }
  if (raw.label.trim().length > MAX_LABEL_LENGTH) {
    return 'label'
  }
  if (!isSourceFormat(raw.format)) {
    return 'format'
  }
  if (normalizeSourceBaseUrl(raw.baseUrl, policy) === null) {
    return 'baseUrl'
  }
  const capabilities = readCapabilities(raw.capabilities)
  if (capabilities === null || new Set(capabilities).size !== capabilities.length) {
    return 'capabilities'
  }
  if (raw.endpoints !== undefined && !isEndpointMap(raw.endpoints)) {
    return 'endpoints'
  }
  return null
}

/**
 * 校验并规范化一份供应端点描述; 不合法时返回 null。
 * 登记前必须走这一步: 注册表里保存、比对与执行的都是规范化之后的值。
 */
export const normalizeSourceDescriptor = (
  value: unknown,
  policy?: HttpEndpointPolicy
): CoreSourceDescriptor | null => {
  if (checkSourceDescriptor(value, policy) !== null) {
    return null
  }
  const raw = value as CoreSourceDescriptor
  const baseUrl = normalizeSourceBaseUrl(raw.baseUrl, policy)
  if (baseUrl === null) {
    return null
  }
  const descriptor: CoreSourceDescriptor = {
    id: raw.id,
    label: raw.label.trim(),
    format: raw.format,
    baseUrl,
    capabilities: [...raw.capabilities],
    ...(raw.endpoints === undefined ? {} : { endpoints: normalizeEndpoints(raw.endpoints) }),
  }
  return descriptor
}
