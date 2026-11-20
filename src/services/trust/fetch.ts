import type { Certificate, CertificateRevocationList } from 'pkijs'
import { setTrustCrl } from './crl.js'
import { requestText } from './net.js'
import type { TrustCollection, TrustFailureReason, TrustList } from './types.js'

/** 信任清单的镜像地址；按顺序尝试，前者失败才用后者 */
export const TRUST_MIRRORS: readonly string[] = [
  'https://cdn.jsdelivr.net/gh/omds-chat/DeepSeek-Chat-Enhanced@online-data/',
  'https://raw.githubusercontent.com/omds-chat/DeepSeek-Chat-Enhanced/online-data/',
]

/** 合集并发校验上限 */
const CONCURRENCY = 4
/**
 * 信任清单文件名；固定位于 online-data 根目录。
 * 根证书与各合集 EEC 的路径不在这里硬编码，一律采用清单里登记的相对路径，
 * 清单按 certs 目录结构给出 certs/ds-chat/... 与 certs/<合集 id>/<合集 id>-eec.crt。
 */
const INDEX_FILE = 'index.json'
/** 信任清单结构版本 */
const SCHEMA_VERSION = 2
/** 合集 id 与路径段允许的字符 */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 清单中的单个合集条目；dir 是 eec 路径里的合集目录名 */
type IndexCollection = { id: string; dir: string; eec: string }

/** 清单解析结果 */
type TrustIndex = { rootCa: string; crl: string | null; collections: IndexCollection[] }

/** 证书链校验结论；revoked 表示失败原因是 EEC 证书已被吊销 */
type ChainOutcome = { ok: boolean; revoked: boolean }

/** 证书链校验函数；由调用方按需加载 pkijs 后传入，避免清单模块自带密码学依赖 */
type ChainCheck = (eecPem: string) => Promise<ChainOutcome>

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

/** 清单登记的 eec 路径里取合集目录名；路径不足两级时返回空串 */
const collectionDirOf = (eecPath: string): string => {
  const segments = eecPath.split('/').filter((segment) => segment !== '')
  return segments.length >= 2 ? segments[segments.length - 2] : ''
}

/** 证书文本归一化；只用于比较，不参与验签 */
const normalizePem = (value: string): string => value.replace(/\r\n?/g, '\n').trim()

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
    const eecPath = isFilled(eec) && isRelativePath(eec.trim()) ? eec.trim() : ''
    const entry: IndexCollection = {
      id: id.trim(),
      dir: collectionDirOf(eecPath),
      eec: eecPath,
    }
    seen.add(entry.id)
    collections.push(entry)
  }
  return { rootCa: rootCa.trim(), crl, collections }
}

/** 不可信条目；证书一律不给出 */
const untrusted = (id: string, dir: string, reason: TrustFailureReason): TrustCollection => ({
  id,
  dir,
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
    return untrusted(entry.id, entry.dir, 'missing')
  }
  const eecText = await requestText(base + entry.eec)
  if (eecText === null || eecText.trim() === '') {
    return untrusted(entry.id, entry.dir, 'missing')
  }
  const outcome = await check(eecText)
  if (!outcome.ok) {
    return untrusted(entry.id, entry.dir, outcome.revoked ? 'revoked' : 'chain')
  }
  return { id: entry.id, dir: entry.dir, eec: eecText, trust: 'trusted', reason: null }
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
  // 根证书以构建时内嵌的信任锚为准：清单登记的那份只用于比对，
  // 不一致时仍用内置根证书校验各合集证书，只把比对结果记下来
  const rootMatched = normalizePem(rootText) === normalizePem(embeddedRootPem)
  if (!rootMatched) {
    // eslint-disable-next-line no-console
    console.warn(
      '[trust] online-data 的 ' + index.rootCa + ' 与构建内嵌的根证书不一致，按构建内嵌的根证书校验'
    )
  }
  const { ensurePkijsEngine, isRevoked, parseCertificate, parseCrl, verifyCertificateChain, verifyCrl } =
    await import('../integrity/x509.js')
  const anchorPem = embeddedRootPem.trim() === '' ? rootText : embeddedRootPem
  const root: Certificate | null = ensurePkijsEngine() ? parseCertificate(anchorPem) : null
  if (!root) {
    setTrustCrl(null)
    return emptyCollections(base, rootText, index.crl)
  }

  /**
   * 拉取并校验清单登记的 CRL：必须由同一根证书签发、未过期，且签名可用根证书公钥验证。
   * 任何一步失败都返回 null，由调用方按吊销状态未知处理。
   */
  const loadRegisteredCrl = async (
    crlPath: string,
    issuer: Certificate
  ): Promise<CertificateRevocationList | null> => {
    const text = await requestText(base + crlPath)
    if (text === null) {
      return null
    }
    const parsed = parseCrl(text)
    if (!parsed) {
      return null
    }
    const verdict = await verifyCrl(parsed, issuer)
    return verdict.ok ? parsed : null
  }

  // 清单登记了 CRL 却拿不到或校验不过时，吊销状态无法确认，整份清单按不可信处理
  const crl = index.crl === null ? null : await loadRegisteredCrl(index.crl, root)
  // 吊销列表交给运行时按需取用：清单只负责分发，吊销结论由使用方用同一张根证书校验
  setTrustCrl(crl)
  if (index.crl !== null && crl === null) {
    return {
      rootMatched,
      origin: base,
      rootCa: rootText,
      crl: index.crl,
      collections: index.collections.map((entry) => untrusted(entry.id, entry.dir, 'chain')),
    }
  }

  const check: ChainCheck = async (eecPem) => {
    const eec = parseCertificate(eecPem)
    if (!eec) {
      return { ok: false, revoked: false }
    }
    const chain = await verifyCertificateChain(root, eec)
    if (!chain.ok) {
      return { ok: false, revoked: false }
    }
    // crl 为 null 表示清单没有登记吊销列表，跳过吊销检查
    if (crl !== null && isRevoked(eec, crl)) {
      return { ok: false, revoked: true }
    }
    return { ok: true, revoked: false }
  }
  const collections = await mapLimited(index.collections, CONCURRENCY, (entry) =>
    verifyCollection(base, entry, check)
  )
  return { rootMatched, origin: base, rootCa: rootText, crl: index.crl, collections }
}
