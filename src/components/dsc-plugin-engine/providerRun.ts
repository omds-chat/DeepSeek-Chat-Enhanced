import {
  IMPLEMENTED_SOURCE_CAPABILITIES,
  type CoreSourceDescriptor,
  type SourceCapabilityId,
} from '../dsc-core/source-catalog.js'
import type {
  CoreModelsListPayload,
  CorePendingSourcePayload,
  CoreSourceModel,
  CoreSourceRunRequest,
  CoreSourceRunResult,
  CoreSourceStreamEvent,
  CoreTextGeneratePayload,
} from '../dsc-core/sources.js'
import type { ReadCredentialResult } from './credentials.js'

/**
 * 按当前选中的供应端点执行一次能力调用。
 * 链路固定四段: 从注册表选出端点 -> 按端点 id 与基址读凭证 -> 带描述与载荷调 core 的 source:run -> 回传结果。
 * 本模块只依赖纯数据模块与类型: 凭证读取、执行入口都由调用方注入,
 * 因此内存夹具可以不给 core 门面建凭证, 也不触碰 store 与网络层。
 * 插件拿到的是回流事件或模型清单, 拿不到端点描述里的凭证与请求对象。
 */

/**
 * 执行失败的错误码。
 * 四类必需区分: 凭证(缺失、被拒)、能力(无人提供或本版未接通)、端点不可达、协议错误;
 * credential-stale 单列, 因为它要求用户重新填写而不是重试。
 */
export type ProviderRunErrorCode =
  /** 没有该「端点 id + 基址」的凭证记录 */
  | 'credential-missing'
  /** 同一端点 id 存在别的基址的记录: 端点换过主机, 旧 Key 不能复用 */
  | 'credential-stale'
  /** 端点拒绝了凭证: 401 或 403 */
  | 'credential-rejected'
  /** 没有端点提供这项能力, 或选中的端点未声明这项能力 */
  | 'capability-unavailable'
  /** 端点声明了这项能力, 本版尚未接通执行 */
  | 'capability-unimplemented'
  /** 请求没有拿到响应: 网络层失败, 或端点基址不可用 */
  | 'endpoint-unreachable'
  /** 拿到响应但不符合协议: 非 2xx、非流式响应、JSON 不合法、流提前结束 */
  | 'protocol-error'

/** 全部错误码; 文档与夹具按这张表核对, 新增码要同时补文档 */
export const PROVIDER_RUN_ERROR_CODES: readonly ProviderRunErrorCode[] = [
  'credential-missing',
  'credential-stale',
  'credential-rejected',
  'capability-unavailable',
  'capability-unimplemented',
  'endpoint-unreachable',
  'protocol-error',
]

/** 按端点执行失败; 原错误只进 detail, 不回传给插件 */
export class PluginProviderRunError extends Error {
  readonly code: ProviderRunErrorCode
  readonly capability: SourceCapabilityId
  /** 选中的端点 id; 还没有选出端点时为 null */
  readonly sourceId: string | null
  readonly detail: string

  constructor(
    code: ProviderRunErrorCode,
    capability: SourceCapabilityId,
    detail: string,
    sourceId: string | null
  ) {
    super('dsc-plugin-engine: provider run rejected (' + code + '): ' + detail)
    this.name = 'PluginProviderRunError'
    this.code = code
    this.capability = capability
    this.sourceId = sourceId
    this.detail = detail
  }
}

/** 流式结果; 事件惰性产出, 网络与解析失败在迭代时抛出 */
export type ProviderStreamResult = {
  readonly kind: 'stream'
  readonly events: AsyncIterable<CoreSourceStreamEvent>
}

/** 一次性结果; 只含模型 id */
export type ProviderModelsResult = {
  readonly kind: 'models'
  readonly models: readonly CoreSourceModel[]
}

/** 一次按端点执行的结果; 本版只有这两种形态 */
export type ProviderRunResult = ProviderStreamResult | ProviderModelsResult

/** 插件交给执行的载荷; 形态由能力标识决定 */
export type ProviderRunPayload =
  | CoreTextGeneratePayload
  | CoreModelsListPayload
  | CorePendingSourcePayload

/**
 * 执行链路的三个依赖。
 * selectedSource 只查注册表, 不读凭证; 凭证与执行分开注入, 使夹具能逐段替换。
 */
export type ProviderRunDeps = {
  /** 当前选中的端点; 没有端点提供该能力时返回 undefined */
  selectedSource(capability: SourceCapabilityId): CoreSourceDescriptor | undefined
  /** 读取「端点 id + 基址」对应的凭证; 由引擎的执行路径提供 */
  readCredential(sourceId: string, baseUrl: string): Promise<ReadCredentialResult>
  /** core 的执行入口, 通常包一层 source:run 票据 */
  execute(request: CoreSourceRunRequest): Promise<CoreSourceRunResult>
}

/** 本版接通的能力; 类型收窄与 core 的已落地清单同源, 避免两处各写一份 */
const isImplemented = (
  capability: SourceCapabilityId
): capability is 'text.generate' | 'models.list' =>
  IMPLEMENTED_SOURCE_CAPABILITIES.includes(capability)

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * core 的拒绝原因。
 * 不 import core 的执行模块: 那会把 API 客户端与 store 的依赖带进引擎的模块图,
 * 也让夹具必须先把构建期全局装好; 错误对象自带 name 与 reason, 按字段判定足够。
 */
const coreRejectReason = (error: unknown): string | null => {
  if (!(error instanceof Error) || error.name !== 'CoreSourceError') {
    return null
  }
  const reason = (error as { reason?: unknown }).reason
  return typeof reason === 'string' ? reason : null
}

/** 协议客户端的失败类别与状态码; 判定口径同上 */
const apiFailure = (error: unknown): { kind: string; status: number | null } | null => {
  if (!(error instanceof Error) || error.name !== 'ApiError') {
    return null
  }
  const kind = (error as { kind?: unknown }).kind
  if (typeof kind !== 'string') {
    return null
  }
  const status = (error as { status?: unknown }).status
  return { kind, status: typeof status === 'number' ? status : null }
}

/**
 * 把执行期的任意错误收敛成插件可判定的错误码。
 * 已经归类过的原样返回; 无法判定的失败不吞, 统一按协议错误抛出并保留原文。
 */
export const classifyProviderRunFailure = (
  error: unknown,
  capability: SourceCapabilityId,
  sourceId: string | null
): PluginProviderRunError => {
  if (error instanceof PluginProviderRunError) {
    return error
  }
  const reason = coreRejectReason(error)
  if (reason === 'capability') {
    return new PluginProviderRunError(
      'capability-unavailable',
      capability,
      'the selected endpoint does not declare this capability',
      sourceId
    )
  }
  if (reason === 'credential') {
    return new PluginProviderRunError('credential-missing', capability, 'the api key is empty', sourceId)
  }
  if (reason === 'endpoint') {
    return new PluginProviderRunError(
      'endpoint-unreachable',
      capability,
      'the endpoint base url is unusable',
      sourceId
    )
  }
  if (reason === 'unsupported') {
    return new PluginProviderRunError(
      'capability-unimplemented',
      capability,
      'the core does not implement this capability yet',
      sourceId
    )
  }
  const failure = apiFailure(error)
  if (failure !== null) {
    if (failure.kind === 'network') {
      return new PluginProviderRunError(
        'endpoint-unreachable',
        capability,
        'the request did not reach the endpoint: ' + describe(error),
        sourceId
      )
    }
    if (failure.kind === 'http' && (failure.status === 401 || failure.status === 403)) {
      return new PluginProviderRunError(
        'credential-rejected',
        capability,
        'the endpoint rejected the api key with status ' + String(failure.status),
        sourceId
      )
    }
    return new PluginProviderRunError(
      'protocol-error',
      capability,
      failure.kind + ': ' + describe(error),
      sourceId
    )
  }
  return new PluginProviderRunError('protocol-error', capability, describe(error), sourceId)
}

/**
 * 回流事件透传, 只把迭代期的失败换成错误码。
 * 惰性是既有的: 鉴权与网络失败要到第一次迭代才发生, 因此这里不能提前结束生成器;
 * 调用方提前停止迭代时, for-await 会关闭内层生成器, 请求随之中止。
 */
const classifyStream = async function* (
  events: AsyncIterable<CoreSourceStreamEvent>,
  capability: SourceCapabilityId,
  sourceId: string,
  signal: AbortSignal | undefined
): AsyncGenerator<CoreSourceStreamEvent> {
  try {
    for await (const event of events) {
      yield event
    }
  } catch (error) {
    // 取消不是失败, 原样抛给调用方, 与其他能力的取消口径一致
    if (signal?.aborted === true) {
      throw error
    }
    throw classifyProviderRunFailure(error, capability, sourceId)
  }
}

/**
 * 按当前选中的端点执行一次能力调用。
 * 顺序是先判能力再读凭证: 本版未接通的能力不该碰到用户的 Key。
 * 失败一律抛 PluginProviderRunError, 不返回空结果, 调用方据 code 区分原因。
 */
export const runProviderCapability = async (
  deps: ProviderRunDeps,
  capability: SourceCapabilityId,
  payload: ProviderRunPayload,
  options: { signal?: AbortSignal } = {}
): Promise<ProviderRunResult> => {
  const { signal } = options
  if (!isImplemented(capability)) {
    throw new PluginProviderRunError(
      'capability-unimplemented',
      capability,
      'capability ' + capability + ' is not implemented yet',
      null
    )
  }
  const source = deps.selectedSource(capability)
  if (source === undefined) {
    throw new PluginProviderRunError(
      'capability-unavailable',
      capability,
      'no registered endpoint provides ' + capability,
      null
    )
  }
  if (!source.capabilities.includes(capability)) {
    throw new PluginProviderRunError(
      'capability-unavailable',
      capability,
      'endpoint ' + source.id + ' does not declare ' + capability,
      source.id
    )
  }
  let read: ReadCredentialResult
  try {
    read = await deps.readCredential(source.id, source.baseUrl)
  } catch (error) {
    // 凭证存储本身读不出来时同样按缺凭证处理: 调用方要做的事都是让用户重新填写
    throw new PluginProviderRunError(
      'credential-missing',
      capability,
      'credential read failed: ' + describe(error),
      source.id
    )
  }
  if (read.status === 'stale') {
    throw new PluginProviderRunError(
      'credential-stale',
      capability,
      'the stored credential belongs to another base url of ' + source.id + ', ask the user to fill it in again',
      source.id
    )
  }
  const apiKey = read.credential === null ? '' : read.credential.apiKey.trim()
  if (read.status !== 'ok' || apiKey === '') {
    throw new PluginProviderRunError(
      'credential-missing',
      capability,
      read.problem === null
        ? 'no credential is stored for ' + source.id + ' at ' + source.baseUrl
        : read.problem,
      source.id
    )
  }
  const secret = { apiKey }
  // 载荷形态由能力标识决定, 插件侧的联合类型在这里收敛成 core 的成对入参
  const request: CoreSourceRunRequest =
    capability === 'text.generate'
      ? {
          source,
          capability,
          payload: payload as CoreTextGeneratePayload,
          secret,
          signal,
        }
      : {
          source,
          capability,
          payload: payload as CoreModelsListPayload,
          secret,
          signal,
        }
  let result: CoreSourceRunResult
  try {
    result = await deps.execute(request)
  } catch (error) {
    if (signal?.aborted === true) {
      throw error
    }
    throw classifyProviderRunFailure(error, capability, source.id)
  }
  if (capability === 'text.generate') {
    if (result.kind !== 'stream') {
      throw new PluginProviderRunError(
        'protocol-error',
        capability,
        'the core returned ' + result.kind + ' for a streaming capability',
        source.id
      )
    }
    return { kind: 'stream', events: classifyStream(result.events, capability, source.id, signal) }
  }
  if (result.kind !== 'models') {
    throw new PluginProviderRunError(
      'protocol-error',
      capability,
      'the core returned ' + result.kind + ' for a one-shot capability',
      source.id
    )
  }
  return { kind: 'models', models: result.models }
}
