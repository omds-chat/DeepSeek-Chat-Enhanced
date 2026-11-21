import { isHttpsOrLocalUrl } from '../../utils/url.js'

/**
 * 资产读取的单次体积上限(字节)。
 * 文本与字节共用这一上限, 与 `net:fetch` 的响应体上限取同一数值, 便于文档统一表述。
 */
export const MAX_ASSET_BYTES = 512 * 1024

/** 资产读取的单次超时(毫秒); 超时用 AbortController 真正中止请求 */
export const ASSET_TIMEOUT_MS = 10000

/** 资产读取被拒绝的原因; 这些判断都是引擎侧可以确定的, 不属于三态 */
export type AssetRejectReason =
  | 'url'
  | 'protocol'
  | 'credential'
  | 'timeout'
  | 'aborted'
  | 'too-large'

/** 资产读取失败 */
export class PluginAssetError extends Error {
  constructor(
    readonly reason: AssetRejectReason,
    detail: string
  ) {
    super(`dsc-core: assets:read rejected (${reason}): ${detail}`)
    this.name = 'PluginAssetError'
  }
}

/**
 * 读取结果的公共三态。
 * content 表示拿到了内容; status 表示拿到了明确的 HTTP 状态码;
 * no-status 表示只有网络层失败、没有任何状态码。
 * 后两态的区别有意保留: 拿到状态码说明对方已放行跨域, 没有状态码时既可能是地址无效,
 * 也可能是对方未放行跨域, 引擎不替插件猜测是哪一种。
 */
type AssetOutcome =
  | { kind: 'status'; url: string; status: number }
  | { kind: 'no-status'; url: string }

/** 文本资产读取结果 */
export type AssetTextResult =
  | { kind: 'content'; url: string; contentType: string; text: string }
  | AssetOutcome

/** 字节资产读取结果 */
export type AssetBytesResult =
  | { kind: 'content'; url: string; contentType: string; bytes: ArrayBuffer }
  | AssetOutcome

/** 响应头已到达时取到的内容; 读体由调用方按形态决定如何交付 */
type AssetContent = { url: string; contentType: string; bytes: ArrayBuffer }

/** 底层请求的结论: 内容、状态码或无状态码 */
type AssetFetch = { kind: 'content'; content: AssetContent } | AssetOutcome

/** 流式读取响应体; 超出上限立即中止读取并抛错 */
const readLimitedBytes = async (response: Response): Promise<ArrayBuffer> => {
  const body = response.body
  if (!body) {
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_ASSET_BYTES) {
      throw new PluginAssetError('too-large', `body exceeds ${MAX_ASSET_BYTES} bytes`)
    }
    return buffer
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }
      total += chunk.value.byteLength
      if (total > MAX_ASSET_BYTES) {
        throw new PluginAssetError('too-large', `body exceeds ${MAX_ASSET_BYTES} bytes`)
      }
      chunks.push(chunk.value)
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  const buffer = new ArrayBuffer(total)
  const merged = new Uint8Array(buffer)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return buffer
}

/**
 * 按地址取一次资产。
 * 只允许 https, 回环主机允许 http; 不发送 Cookie 与自定义请求头(`credentials: 'omit'`),
 * 不接受地址里内嵌的用户名与密码; 响应体上限 512KB, 超时 10 秒。
 * 拿到响应头即视为拿到了状态码: 非 2xx 原样回传状态码, 读体中途断流同样回传状态码;
 * 只有 `fetch` 本身拒绝时才回传无状态码。
 */
const requestAsset = async (url: string, signal?: AbortSignal): Promise<AssetFetch> => {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    throw new PluginAssetError('url', 'target is not an absolute URL')
  }
  if (target.username !== '' || target.password !== '') {
    throw new PluginAssetError('credential', 'target must not embed credentials')
  }
  if (!isHttpsOrLocalUrl(target.href)) {
    throw new PluginAssetError('protocol', 'target must use https or a loopback http host')
  }
  if (signal?.aborted) {
    throw new PluginAssetError('aborted', 'request was aborted before it started')
  }
  const controller = new AbortController()
  let timedOut = false
  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, ASSET_TIMEOUT_MS)
  const forward = () => controller.abort()
  signal?.addEventListener('abort', forward, { once: true })
  try {
    let response: Response
    try {
      response = await fetch(target.href, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'follow',
        signal: controller.signal,
      })
    } catch {
      if (timedOut) {
        throw new PluginAssetError('timeout', `no response within ${ASSET_TIMEOUT_MS}ms`)
      }
      if (signal?.aborted) {
        throw new PluginAssetError('aborted', 'request was aborted')
      }
      return { kind: 'no-status', url: target.href }
    }
    const finalUrl = response.url === '' ? target : new URL(response.url)
    if (!isHttpsOrLocalUrl(finalUrl.href)) {
      throw new PluginAssetError('protocol', 'response came from a disallowed URL')
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      return { kind: 'status', url: finalUrl.href, status: response.status }
    }
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
      void response.body?.cancel().catch(() => undefined)
      throw new PluginAssetError('too-large', `body exceeds ${MAX_ASSET_BYTES} bytes`)
    }
    try {
      const bytes = await readLimitedBytes(response)
      return {
        kind: 'content',
        content: {
          url: finalUrl.href,
          contentType: response.headers.get('content-type') ?? '',
          bytes,
        },
      }
    } catch (error) {
      if (error instanceof PluginAssetError) {
        throw error
      }
      if (timedOut) {
        throw new PluginAssetError('timeout', `body not read within ${ASSET_TIMEOUT_MS}ms`)
      }
      if (signal?.aborted) {
        throw new PluginAssetError('aborted', 'request was aborted')
      }
      return { kind: 'status', url: finalUrl.href, status: response.status }
    }
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

/**
 * 读取资产文本。
 * 按 UTF-8 解码, 非法字节替换为替换字符; 需要原始字节时改用 `readAssetBytes`。
 * 响应类型不做限制: 内容是否可用由插件判断, 引擎不猜测。
 */
export const readAssetText = async (
  url: string,
  signal?: AbortSignal
): Promise<AssetTextResult> => {
  const outcome = await requestAsset(url, signal)
  if (outcome.kind !== 'content') {
    return outcome
  }
  const { url: finalUrl, contentType, bytes } = outcome.content
  return { kind: 'content', url: finalUrl, contentType, text: new TextDecoder().decode(bytes) }
}

/** 读取资产字节; 响应类型不做限制, 图片与压缩包等二进制资产同样按字节交付 */
export const readAssetBytes = async (
  url: string,
  signal?: AbortSignal
): Promise<AssetBytesResult> => {
  const outcome = await requestAsset(url, signal)
  if (outcome.kind !== 'content') {
    return outcome
  }
  const { url: finalUrl, contentType, bytes } = outcome.content
  return { kind: 'content', url: finalUrl, contentType, bytes }
}
