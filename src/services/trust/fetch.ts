import { readPublicKey, verifyBytesSignature } from '../integrity/ed25519.js'
import type { TrustCollection, TrustFailureReason, TrustList } from './types.js'

/** 信任清单的镜像地址；按顺序尝试，前者失败才用后者 */
export const TRUST_MIRRORS: readonly string[] = [
  'https://cdn.jsdelivr.net/gh/omdsc-dev/DeepSeek-Chat-Enhanced@online-data/',
  'https://raw.githubusercontent.com/omdsc-dev/DeepSeek-Chat-Enhanced/online-data/',
]

/** 单个请求的最长等待时间（毫秒） */
export const REQUEST_TIMEOUT = 1000
/** 合集并发校验上限 */
const CONCURRENCY = 4
/** 清单与公钥文件名；与 online-data 分支一致 */
const INDEX_FILE = 'index.json'
/** 清单结构版本 */
const SCHEMA_VERSION = 1
/** 信任签名的签名者标识 */
const SIGNER = 'dsc'
/** 合集 id 与路径段允许的字符 */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 清单中的单个合集条目 */
type IndexCollection = { id: string; publicKey: string; trustSignature: string }

/** 清单解析结果 */
type TrustIndex = { webPublicKey: string; collections: IndexCollection[] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFilled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

/** 只接受清单内的相对路径，避免清单把校验指向站外地址 */
const isRelativePath = (value: string): boolean =>
  value !== '' &&
  !value.startsWith('/') &&
  !value.includes('..') &&
  !/^[a-z][a-z0-9+.-]*:/i.test(value)

/** 公钥文本归一化；只用于比较，不参与验签 */
export const normalizePem = (value: string): string => value.replace(/\r\n?/g, '\n').trim()

/** 带超时的请求；超时或失败返回 null，由调用方换下一个地址 */
const requestWith = async <T>(
  url: string,
  read: (response: Response) => Promise<T>
): Promise<T | null> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    return response.ok ? await read(response) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 读取文本资源 */
const requestText = (url: string): Promise<string | null> =>
  requestWith(url, (response) => response.text())

/** 读取二进制资源，供网页签名校验复用同一套镜像与超时语义 */
export const requestBytes = (url: string): Promise<Uint8Array<ArrayBuffer> | null> =>
  requestWith(url, async (response) => new Uint8Array(await response.arrayBuffer()))

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** 解析 index.json；整体结构不符返回 null，由调用方换下一个镜像 */
export const parseTrustIndex = (text: string): TrustIndex | null => {
  const parsed = parseJson(text)
  if (!isRecord(parsed) || parsed.schemaVersion !== SCHEMA_VERSION) {
    return null
  }
  const webPublicKey = parsed.webPublicKey
  if (!isFilled(webPublicKey) || !isRelativePath(webPublicKey.trim())) {
    return null
  }
  if (!Array.isArray(parsed.collections)) {
    return null
  }
  const collections: IndexCollection[] = []
  const seen = new Set<string>()
  for (const item of parsed.collections) {
    if (!isRecord(item)) {
      continue
    }
    const { id, publicKey, trustSignature } = item
    // id 是合集的对外标识，不合法时无法与来源对应，直接跳过
    if (!isFilled(id) || !SEGMENT_PATTERN.test(id.trim()) || seen.has(id.trim())) {
      continue
    }
    const entry: IndexCollection = {
      id: id.trim(),
      publicKey: isFilled(publicKey) && isRelativePath(publicKey.trim()) ? publicKey.trim() : '',
      trustSignature:
        isFilled(trustSignature) && isRelativePath(trustSignature.trim()) ? trustSignature.trim() : '',
    }
    seen.add(entry.id)
    collections.push(entry)
  }
  return { webPublicKey: webPublicKey.trim(), collections }
}

/** 取出 signer 为 dsc 的签名值；结构不符返回 null */
const readDscSignatures = (text: string): string[] | null => {
  const parsed = parseJson(text)
  if (!isRecord(parsed) || !Array.isArray(parsed.sign)) {
    return null
  }
  const values: string[] = []
  for (const item of parsed.sign) {
    if (!isRecord(item)) {
      return null
    }
    const { value, signer } = item
    if (typeof value !== 'string' || typeof signer !== 'string') {
      return null
    }
    if (signer === SIGNER && value !== '') {
      values.push(value)
    }
  }
  return values
}

/** 不可信条目；公钥一律不给出 */
const untrusted = (id: string, reason: TrustFailureReason): TrustCollection => ({
  id,
  publicKey: null,
  trust: 'untrusted',
  reason,
})

/**
 * 核对单个合集：拉取公钥与信任签名，用内嵌的 dsc 公钥验签。
 * 材料缺失记为 missing，公钥本身不可用记为 publicKey，签名不通过记为 signature；
 * 三种情况都只标记为不可信，不影响其余合集。
 */
const verifyCollection = async (
  base: string,
  entry: IndexCollection,
  dscKeyPem: string
): Promise<TrustCollection> => {
  if (entry.publicKey === '' || entry.trustSignature === '') {
    return untrusted(entry.id, 'missing')
  }
  const pubText = await requestText(base + entry.publicKey)
  if (pubText === null || pubText.trim() === '') {
    return untrusted(entry.id, 'missing')
  }
  if (!readPublicKey(pubText)) {
    return untrusted(entry.id, 'publicKey')
  }
  const signText = await requestText(base + entry.trustSignature)
  if (signText === null) {
    return untrusted(entry.id, 'missing')
  }
  const values = readDscSignatures(signText)
  if (!values || values.length === 0) {
    return untrusted(entry.id, 'missing')
  }
  // 被签名对象是公钥文件的字节；按文本读回后重新编码，与签发端一致
  const bytes = new TextEncoder().encode(pubText)
  for (const value of values) {
    if (await verifyBytesSignature(bytes, value, dscKeyPem)) {
      return { id: entry.id, publicKey: pubText, trust: 'trusted', reason: null }
    }
  }
  return untrusted(entry.id, 'signature')
}

/** 以固定并发上限处理列表，保持结果顺序 */
const mapLimited = async <T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await task(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * 从一个镜像拉取并核对整份清单。
 * 清单或 web_public.pem 拉不到、结构不符时返回 null，由调用方换下一个镜像；
 * 内嵌公钥与拉取到的 web_public.pem 不一致时返回未被采信的空清单。
 */
export const fetchTrustListFrom = async (
  base: string,
  dscKeyPem: string
): Promise<TrustList | null> => {
  const indexText = await requestText(base + INDEX_FILE)
  if (indexText === null) {
    return null
  }
  const index = parseTrustIndex(indexText)
  if (!index) {
    return null
  }
  const webPem = await requestText(base + index.webPublicKey)
  if (webPem === null) {
    return null
  }
  if (normalizePem(webPem) !== normalizePem(dscKeyPem)) {
    return { webKeyMatched: false, origin: base, collections: [] }
  }
  const collections = await mapLimited(index.collections, CONCURRENCY, (entry) =>
    verifyCollection(base, entry, dscKeyPem)
  )
  return { webKeyMatched: true, origin: base, collections }
}
