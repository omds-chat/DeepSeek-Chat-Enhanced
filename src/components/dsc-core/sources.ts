import { fetchModelList, streamMessageAt } from '../../services/api/client.js'
import { serverTools } from '../../services/api/tools.js'
import type {
  CreateMessageRequest,
  FileBlockParam,
  MessageParam,
  TextBlockParam,
} from '../../services/api/types.js'

import {
  normalizeSourceBaseUrl,
  sourceEndpoint,
  type CoreSourceDescriptor,
  type SourceCapabilityId,
} from './source-catalog.js'

/** 用户消息内容块的协议形态 */
type UserContentBlockParam = FileBlockParam | TextBlockParam

/**
 * 按供应端点描述执行内核能力。
 * core 只认能力标识与协议格式, 不认厂商: 请求怎么组装、回流怎么解析, 都由描述的 format 决定。
 * 凭证由调用方在执行时给出, 只在这一次调用里使用; core 不保存、不返回、不放进任何回流事件。
 */

/** 文本块 */
export type CoreSourceTextBlock = { readonly type: 'text'; readonly text: string }

/** 文件块; 图片与文档共用一种形态, 是否可接受由描述声明的能力决定 */
export type CoreSourceFileBlock = {
  readonly type: 'image' | 'document'
  /** 已上传到该供应端点的文件 id */
  readonly fileId: string
}

/** 消息内容块 */
export type CoreSourceContentBlock = CoreSourceTextBlock | CoreSourceFileBlock

/**
 * 与供应端点无关的消息形态。
 * 续写所需的思考块与服务端工具块属于具体协议, 尚未进入骨架, 因此这里只声明文本与文件两类内容。
 */
export type CoreSourceMessage =
  /** 位于下一轮用户消息之前的提醒行, 对应既有发送路径的 latest_reminder */
  | { readonly role: 'latest_reminder'; readonly content: string }
  | { readonly role: 'user'; readonly content: string | readonly CoreSourceContentBlock[] }
  | { readonly role: 'assistant'; readonly content: readonly CoreSourceTextBlock[] }

/** text.generate 的载荷 */
export type CoreTextGeneratePayload = {
  readonly model: string
  readonly system: string
  readonly messages: readonly CoreSourceMessage[]
  /** 是否请求思考过程 */
  readonly thinking?: boolean
  /** 是否声明联网搜索工具 */
  readonly search?: boolean
  /** 是否请求服务端生成标题 */
  readonly title?: boolean
  readonly temperature?: number
  readonly topP?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
}

/** models.list 的载荷; 目前没有可选参数, 保留形态以便后续按端点过滤 */
export type CoreModelsListPayload = Record<string, never>

/** 尚未落地的能力; 载荷形态待定 */
export type CorePendingSourceCapability = Exclude<
  SourceCapabilityId,
  'text.generate' | 'models.list'
>

/** 尚未落地能力的载荷占位 */
export type CorePendingSourcePayload = Record<string, unknown>

/** 供应端点凭证; 只有 core 在执行时取用, 插件拿不到 */
export type CoreSourceSecret = { readonly apiKey: string }

/** 回流事件的停止原因; 与协议取值一致, 没有收到 message_delta 时为 null */
export type CoreSourceStopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal'

/** 与协议无关的回流事件 */
export type CoreSourceStreamEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | { readonly type: 'title'; readonly title: string }
  | { readonly type: 'end'; readonly stopReason: CoreSourceStopReason | null }

/** 模型清单条目 */
export type CoreSourceModel = { readonly id: string }

/** 一次按供应端点执行的结果; 按能力给出不同形态 */
export type CoreSourceRunResult =
  | { readonly kind: 'stream'; readonly events: AsyncIterable<CoreSourceStreamEvent> }
  | { readonly kind: 'models'; readonly models: readonly CoreSourceModel[] }

/** 执行入口的入参; 能力与载荷成对出现, 其余能力走占位形态 */
export type CoreSourceRunRequest =
  | {
      readonly source: CoreSourceDescriptor
      readonly capability: 'text.generate'
      readonly payload: CoreTextGeneratePayload
      readonly secret: CoreSourceSecret
      readonly signal?: AbortSignal
    }
  | {
      readonly source: CoreSourceDescriptor
      readonly capability: 'models.list'
      readonly payload: CoreModelsListPayload
      readonly secret: CoreSourceSecret
      readonly signal?: AbortSignal
    }
  | {
      readonly source: CoreSourceDescriptor
      readonly capability: CorePendingSourceCapability
      readonly payload: CorePendingSourcePayload
      readonly secret: CoreSourceSecret
      readonly signal?: AbortSignal
    }

/** 按供应端点执行被拒绝的原因 */
export type CoreSourceRejectReason =
  /** 描述里没有声明这项能力 */
  | 'capability'
  /** 凭证为空 */
  | 'credential'
  /** 端点基址不可用: 规范化失败 */
  | 'endpoint'
  /** 该能力尚未落地 */
  | 'unsupported'

/** 按供应端点执行失败 */
export class CoreSourceError extends Error {
  constructor(
    readonly reason: CoreSourceRejectReason,
    detail: string
  ) {
    super(`dsc-core: source execution rejected (${reason}): ${detail}`)
    this.name = 'CoreSourceError'
  }
}

/** 取出可用的凭证; 空串按拒绝处理, 不发出没有鉴权的请求 */
const requireApiKey = (secret: CoreSourceSecret): string => {
  const apiKey = typeof secret?.apiKey === 'string' ? secret.apiKey.trim() : ''
  if (apiKey === '') {
    throw new CoreSourceError('credential', 'source api key is empty')
  }
  return apiKey
}

/** 用户消息的内容块; 文本块与文件块各自落成协议字段 */
const toUserContent = (content: readonly CoreSourceContentBlock[]): UserContentBlockParam[] =>
  content.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: block.type, source: { type: 'file', file_id: block.fileId } }
  )

const toMessageParam = (message: CoreSourceMessage): MessageParam => {
  if (message.role === 'latest_reminder') {
    return { role: 'latest_reminder', content: message.content }
  }
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content.map((block) => ({ type: 'text' as const, text: block.text })),
    }
  }
  if (typeof message.content === 'string') {
    return { role: 'user', content: message.content }
  }
  return { role: 'user', content: toUserContent(message.content) }
}

/**
 * 组装 text.generate 的请求体。
 * 字段与既有发送路径一致: 安全审核固定开启, 阅读链接始终声明, 联网搜索与标题生成按载荷开关声明,
 * 温度、核采样、输出上限与停止词只在载荷给出时出现。
 */
export const assembleTextGenerateRequest = (
  payload: CoreTextGeneratePayload
): CreateMessageRequest => {
  const body: CreateMessageRequest = {
    // 协议类型把 model 收窄到本应用已知的两个取值; 端点可以提供别的模型, 这里按协议字段原样透传
    model: payload.model as CreateMessageRequest['model'],
    system: payload.system,
    messages: payload.messages.map(toMessageParam),
    thinking: { type: payload.thinking === true ? 'enabled' : 'disabled' },
    safety_check: { level: 'high' },
    tools: serverTools(payload.search === true),
  }
  if (payload.title === true) {
    body.title = { enabled: true }
  }
  if (payload.temperature !== undefined) {
    body.temperature = payload.temperature
  }
  if (payload.topP !== undefined) {
    body.top_p = payload.topP
  }
  if (payload.maxTokens !== undefined) {
    body.max_tokens = payload.maxTokens
  }
  if (payload.stop !== undefined) {
    body.stop_sequences = [...payload.stop]
  }
  return body
}

/**
 * 把协议回流折算成与协议无关的事件。
 * 正文与思考分开回流; 标题在 message_delta 上出现时单独给一条;
 * 引用、搜索结果与工具块属于具体协议, 尚未进入骨架。
 */
const generateTextStream = async function* (
  source: CoreSourceDescriptor,
  payload: CoreTextGeneratePayload,
  apiKey: string,
  signal: AbortSignal
): AsyncGenerator<CoreSourceStreamEvent> {
  const events = streamMessageAt(
    sourceEndpoint(source, 'text.generate'),
    apiKey,
    assembleTextGenerateRequest(payload),
    signal
  )
  let stopReason: CoreSourceStopReason | null = null
  for await (const event of events) {
    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text }
      } else if (event.delta.type === 'thinking_delta') {
        yield { type: 'thinking', text: event.delta.thinking }
      }
      continue
    }
    if (event.type === 'message_delta') {
      stopReason = event.delta.stop_reason
      const title = event.delta.title?.trim() ?? ''
      if (title !== '') {
        yield { type: 'title', title }
      }
      continue
    }
    if (event.type === 'message_stop') {
      yield { type: 'end', stopReason }
      return
    }
  }
  // 没有收到 message_stop 时由 streamMessageAt 抛错, 这一行只保证生成器有正常的收尾分支
  yield { type: 'end', stopReason }
}

/** 读取模型清单; 只回传 id, 其余字段不进入回流 */
const listModels = async (
  source: CoreSourceDescriptor,
  apiKey: string,
  signal: AbortSignal
): Promise<CoreSourceModel[]> => {
  const models = await fetchModelList(sourceEndpoint(source, 'models.list'), apiKey, signal)
  return models.map((model) => ({ id: model.id }))
}

/**
 * 按供应端点描述执行一次能力调用。
 * 先校验描述是否声明了该能力: 没有声明的能力一律拒绝, 与"执行时才发现不支持"区分开。
 * 流式结果的回流是惰性的: 凭证为空在执行时即可拒绝, 鉴权与网络失败要到第一次迭代才抛出。
 */
export const executeSource = async (
  request: CoreSourceRunRequest
): Promise<CoreSourceRunResult> => {
  const { source, capability, payload, secret } = request
  if (!source.capabilities.includes(capability)) {
    throw new CoreSourceError(
      'capability',
      `source ${source.id} does not declare ${capability}`
    )
  }
  // 执行期只用规范化后的基址: 调用方传入的字符串可能带空白或尾斜杠, 与注册表里的值不是同一个
  const baseUrl = normalizeSourceBaseUrl(source.baseUrl)
  if (baseUrl === null) {
    throw new CoreSourceError('endpoint', `source ${source.id} has an unusable base url`)
  }
  const target: CoreSourceDescriptor = baseUrl === source.baseUrl ? source : { ...source, baseUrl }
  const signal = request.signal ?? new AbortController().signal
  if (capability === 'text.generate') {
    const apiKey = requireApiKey(secret)
    return { kind: 'stream', events: generateTextStream(target, payload, apiKey, signal) }
  }
  if (capability === 'models.list') {
    const apiKey = requireApiKey(secret)
    return { kind: 'models', models: await listModels(target, apiKey, signal) }
  }
  // TODO reasoning.think、vision.image、document.read、audio.asr、audio.tts、tool.web-search
  // TODO 与 tool.read-url 的载荷形态与回流解析尚未定稿, 先按 unsupported 拒绝。
  throw new CoreSourceError('unsupported', `capability ${capability} is not implemented`)
}
