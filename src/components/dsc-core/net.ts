/** 外源请求只允许的协议 */
const ALLOWED_PROTOCOL = 'https:'
/** 单次响应体上限（字节） */
const MAX_BODY_BYTES = 512 * 1024
/** 单次请求超时（毫秒） */
const REQUEST_TIMEOUT = 10000

/** 外源请求被拒绝的原因；供引擎映射文案 */
export type FetchRejectReason =
  | 'url'
  | 'protocol'
  | 'timeout'
  | 'aborted'
  | 'status'
  | 'content-type'
  | 'too-large'
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
