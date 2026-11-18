import type { Certificate } from 'pkijs'
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
/** 信任清单文件名；与 online-data 分支一致 */
const INDEX_FILE = 'index.json'
/** 信任清单结构版本 */
const SCHEMA_VERSION = 2
/** 合集 id 与路径段允许的字符 */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 清单中的单个合集条目 */
type IndexCollection = { id: string; eec: string }

/** 清单解析结果 */
type TrustIndex = { rootCa: string; crl: string | null; collections: IndexCollection[] }

/** 证书链校验函数；由调用方按需加载 pkijs 后传入，避免清单模块自带密码学依赖 */
type ChainCheck = (eecPem: string) => Promise<boolean>

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

/** 证书文本归一化；只用于比较，不参与验签 */
const normalizePem = (value: string): string => value.replace(/\r\n?/g, '\n').trim()

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

/**
 * 解析 index.json。
 * schemaVersion 必须为 2，rootCa 与各合集的 eec 都是清单内的相对路径；
 * 结构不符时返回 null，由调用方换下一个镜像。
 */
export const parseTrustIndex = (text: string): TrustIndex | null => {
  const parsed = parseJson(text)
  if (!isRecord(parsed) || parsed.schemaVersion !== SCHEMA_VERSION) {
    return null
  }
  const rootCa = parsed.rootCa
  if (!isFilled(rootCa) || !isRelativePath(rootCa.trim())) {
    return null
  }
  const crl = isFilled(parsed.crl) && isRelativePath(parsed.crl.trim()) ? parsed.crl.trim() : null
  if (!Array.isArray(parsed.collections)) {
    return null
  }
  const collections: IndexCollection[] = []
  const seen = new Set<string>()
  for (const item of parsed.collections) {
    if (!isRecord(item)) {
      continue
    }
    const { id, eec } = item
    // id 是合集的对外标识，不合法时无法与来源对应，直接跳过
    if (!isFilled(id) || !SEGMENT_PATTERN.test(id.trim()) || seen.has(id.trim())) {
      continue
    }
    const entry: IndexCollection = {
      id: id.trim(),
      eec: isFilled(eec) && isRelativePath(eec.trim()) ? eec.trim() : '',
    }
    seen.add(entry.id)
    collections.push(entry)
  }
  return { rootCa: rootCa.trim(), crl, collections }
}

/** 不可信条目；证书一律不给出 */
const untrusted = (id: string, reason: TrustFailureReason): TrustCollection => ({
  id,
  eec: null,
  trust: 'untrusted',
  reason,
})

/**
 * 核对单个合集：拉取清单登记的 EEC 证书，再用根证书校验证书链。
 * 证书文件缺失记为 missing，链校验不通过记为 chain；
 * 两种情况都只标记为不可信，不影响其余合集。
 */
const verifyCollection = async (
  base: string,
  entry: IndexCollection,
  check: ChainCheck
): Promise<TrustCollection> => {
  if (entry.eec === '') {
    return untrusted(entry.id, 'missing')
  }
  const eecText = await requestText(base + entry.eec)
  if (eecText === null || eecText.trim() === '') {
    return untrusted(entry.id, 'missing')
  }
  if (!(await check(eecText))) {
    return untrusted(entry.id, 'chain')
  }
  return { id: entry.id, eec: eecText, trust: 'trusted', reason: null }
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

/** 空的合集清单；根证书缺失、不匹配或环境没有 WebCrypto 时使用 */
const emptyCollections = (base: string, rootCa: string | null, crl: string | null): TrustList => ({
  rootMatched: rootCa !== null,
  origin: base,
  rootCa,
  crl,
  collections: [],
})

/**
 * 从一个镜像拉取并核对整份清单。
 * 清单或根证书拉不到、结构不符时返回 null，由调用方换下一个镜像；
 * 根证书与内嵌根证书不一致时返回未被采信的空清单。
 */
export const fetchTrustListFrom = async (
  base: string,
  embeddedRootPem: string
): Promise<TrustList | null> => {
  const indexText = await requestText(base + INDEX_FILE)
  if (indexText === null) {
    return null
  }
  const index = parseTrustIndex(indexText)
  if (!index) {
    return null
  }
  const rootText = await requestText(base + index.rootCa)
  if (rootText === null || rootText.trim() === '') {
    return null
  }
  // 根证书通过 online-data 分发，必须与构建时内嵌的信任锚逐字一致
  if (embeddedRootPem.trim() === '' || normalizePem(rootText) !== normalizePem(embeddedRootPem)) {
    return { rootMatched: false, origin: base, rootCa: rootText, crl: index.crl, collections: [] }
  }
  const { ensurePkijsEngine, parseCertificate, verifyCertificateChain } = await import(
    '../integrity/x509.js'
  )
  const root: Certificate | null = ensurePkijsEngine() ? parseCertificate(rootText) : null
  if (!root) {
    return emptyCollections(base, rootText, index.crl)
  }
  const check: ChainCheck = async (eecPem) => {
    const eec = parseCertificate(eecPem)
    if (!eec) {
      return false
    }
    const chain = await verifyCertificateChain(root, eec)
    return chain.ok
  }
  const collections = await mapLimited(index.collections, CONCURRENCY, (entry) =>
    verifyCollection(base, entry, check)
  )
  return { rootMatched: true, origin: base, rootCa: rootText, crl: index.crl, collections }
}
