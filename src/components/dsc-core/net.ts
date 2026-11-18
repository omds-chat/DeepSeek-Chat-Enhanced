/** 外源请求只允许的协议 */
const ALLOWED_PROTOCOL = 'https:'
/** 单次响应体上限（字节） */
const MAX_BODY_BYTES = 512 * 1024
/** 单次请求超时（毫秒） */
const REQUEST_TIMEOUT = 10000
/** 计数请求超时（毫秒） */
const POST_TIMEOUT = 5000
/** 计数请求的请求体上限（字节） */
const MAX_POST_REQUEST_BYTES = 4 * 1024
/** 计数请求的响应体上限（字节） */
const MAX_POST_RESPONSE_BYTES = 4 * 1024

/** 外源请求被拒绝的原因；供引擎映射文案 */
export type FetchRejectReason =
  | 'url'
  | 'protocol'
  | 'timeout'
  | 'aborted'
  | 'status'
  | 'content-type'
  | 'too-large'
  | 'body'
  | 'redirect'
  | 'network'

/** 外源请求失败 */
export class PluginFetchError extends Error {
  constructor(
    readonly reason: FetchRejectReason,
    detail: string
  ) {
    super(`dsc-core: net:fetch rejected (${reason}): ${detail}`)
    this.name = 'PluginFetchError'
  }
}

/** 外源请求结果；只回传文本与最终地址 */
export type FetchTextResult = {
  url: string
  contentType: string
  text: string
}

/** 计数请求结果；响应体只做丢弃，不进入调用方 */
export type PostJsonResult = {
  url: string
  status: number
}

/** 只接受 text/* 与 application/json，其余一律拒绝 */
const isTextual = (contentType: string): boolean => {
  const mime = contentType.split(';')[0].trim().toLowerCase()
  return mime.startsWith('text/') || mime === 'application/json'
}

const encoder = new TextEncoder()

/** 流式读取响应体；超出上限立即中止读取并抛错 */
const readLimitedBody = async (response: Response): Promise<string> => {
  const body = response.body
  if (!body) {
    const text = await response.text()
    if (encoder.encode(text).byteLength > MAX_BODY_BYTES) {
      throw new PluginFetchError('too-large', `body exceeds ${MAX_BODY_BYTES} bytes`)
    }
    return text
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }
      total += chunk.value.byteLength
      if (total > MAX_BODY_BYTES) {
        throw new PluginFetchError('too-large', `body exceeds ${MAX_BODY_BYTES} bytes`)
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  return text + decoder.decode()
}

/**
 * 读取外源文本资源。
 * 只允许 https 与 GET，不发送 Cookie 与自定义请求头，响应体上限 512KB，超时 10 秒并真正中止请求。
 */
export const fetchText = async (url: string, signal?: AbortSignal): Promise<FetchTextResult> => {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    throw new PluginFetchError('url', 'target is not an absolute URL')
  }
  if (target.protocol !== ALLOWED_PROTOCOL) {
    throw new PluginFetchError('protocol', `target must use ${ALLOWED_PROTOCOL}`)
  }
  if (signal?.aborted) {
    throw new PluginFetchError('aborted', 'request was aborted before it started')
  }
  const controller = new AbortController()
  let timedOut = false
  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT)
  const forward = () => controller.abort()
  signal?.addEventListener('abort', forward, { once: true })
  try {
    const response = await fetch(target.href, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
    })
    const finalUrl = response.url === '' ? target : new URL(response.url)
    if (finalUrl.protocol !== ALLOWED_PROTOCOL) {
      throw new PluginFetchError('protocol', 'response came from a non-https URL')
    }
    if (!response.ok) {
      throw new PluginFetchError('status', `response status ${response.status}`)
    }
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      throw new PluginFetchError('too-large', `body exceeds ${MAX_BODY_BYTES} bytes`)
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (!isTextual(contentType)) {
      throw new PluginFetchError('content-type', `unsupported content type ${contentType}`)
    }
    const text = await readLimitedBody(response)
    return { url: finalUrl.href, contentType, text }
  } catch (error) {
    if (error instanceof PluginFetchError) {
      throw error
    }
    if (timedOut) {
      throw new PluginFetchError('timeout', `no response within ${REQUEST_TIMEOUT}ms`)
    }
    if (signal?.aborted) {
      throw new PluginFetchError('aborted', 'request was aborted')
    }
    throw new PluginFetchError('network', error instanceof Error ? error.message : String(error))
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

/** 读取并丢弃响应体；读满上限立即停止，不把内容交给调用方 */
const drainLimitedBody = async (response: Response): Promise<void> => {
  const body = response.body
  if (!body) {
    return
  }
  const reader = body.getReader()
  let total = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        return
      }
      total += chunk.value.byteLength
      if (total > MAX_POST_RESPONSE_BYTES) {
        return
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

/**
 * 发送一次 JSON 请求体的 POST。
 * 只允许 https 与 JSON 请求体，请求体与响应体上限各 4KB，超时 5 秒并真正中止请求；
 * 不跟随重定向，不发送 Cookie，响应内容丢弃，只回传状态码。
 */
export const postJson = async (
  url: string,
  body: unknown,
  signal?: AbortSignal
): Promise<PostJsonResult> => {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    throw new PluginFetchError('url', 'target is not an absolute URL')
  }
  if (target.protocol !== ALLOWED_PROTOCOL) {
    throw new PluginFetchError('protocol', `target must use ${ALLOWED_PROTOCOL}`)
  }
  let payload: string
  try {
    const serialized: unknown = JSON.stringify(body)
    if (typeof serialized !== 'string') {
      throw new PluginFetchError('body', 'body is not JSON serializable')
    }
    payload = serialized
  } catch (error) {
    if (error instanceof PluginFetchError) {
      throw error
    }
    throw new PluginFetchError('body', 'body is not JSON serializable')
  }
  if (encoder.encode(payload).byteLength > MAX_POST_REQUEST_BYTES) {
    throw new PluginFetchError('too-large', `body exceeds ${MAX_POST_REQUEST_BYTES} bytes`)
  }
  if (signal?.aborted) {
    throw new PluginFetchError('aborted', 'request was aborted before it started')
  }
  const controller = new AbortController()
  let timedOut = false
  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, POST_TIMEOUT)
  const forward = () => controller.abort()
  signal?.addEventListener('abort', forward, { once: true })
  try {
    const response = await fetch(target.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      credentials: 'omit',
      // 计数接口不应重定向；出现重定向按拒绝处理，避免把请求体转投他处
      redirect: 'manual',
      signal: controller.signal,
    })
    if (
      response.type === 'opaqueredirect' ||
      response.status === 0 ||
      (response.status >= 300 && response.status < 400)
    ) {
      throw new PluginFetchError('redirect', 'redirects are not followed')
    }
    if (!response.ok) {
      throw new PluginFetchError('status', `response status ${response.status}`)
    }
    await drainLimitedBody(response)
    return { url: target.href, status: response.status }
  } catch (error) {
    if (error instanceof PluginFetchError) {
      throw error
    }
    if (timedOut) {
      throw new PluginFetchError('timeout', `no response within ${POST_TIMEOUT}ms`)
    }
    if (signal?.aborted) {
      throw new PluginFetchError('aborted', 'request was aborted')
    }
    throw new PluginFetchError('network', error instanceof Error ? error.message : String(error))
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}
