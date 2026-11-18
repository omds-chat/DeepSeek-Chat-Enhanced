import type { CertificateRevocationList } from 'pkijs'
import { showToast } from '../../components/base/toastState.js'
import { parseTrustIndex, requestBytes, TRUST_MIRRORS } from '../trust/fetch.js'
import { derEquals, pemToDer } from './pem.js'

/** 解析与验签模块按需加载，未注入根证书时不会进入首屏代码 */
const loadVerifier = async () => ({
  ...(await import('./x509.js')),
  ...(await import('./cms.js')),
})

/** 网页清单文件名，与 index.html 同目录 */
const MANIFEST_FILE = 'web_files.json'
/** 签名后缀，每个被签名文件对应 <文件>.sig */
const SIGNATURE_SUFFIX = '.sig'
/** 清单结构版本 */
const SCHEMA_VERSION = 1
/** online-data 上的信任清单路径，用于取吊销列表 */
const INDEX_FILE = 'index.json'
/** online-data 上的根证书路径 */
const ROOT_CA_PATH = 'root_ca.crt'
/** online-data 上的网页 EEC 证书路径 */
const EEC_PATH = 'web/eec.pem'
/** 并行校验文件的上限 */
const CONCURRENCY = 6
/** 提示文案中最多列出的文件名数量 */
const MAX_REPORTED = 5

let started = false

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 只接受相对路径，避免清单把校验指向站外地址 */
const isLocalPath = (value: string): boolean =>
  value !== '' &&
  !value.startsWith('/') &&
  !value.includes('..') &&
  !/^[a-z][a-z0-9+.-]*:/i.test(value)

/** 构建时注入的根证书 PEM；未注入时为空串 */
const embeddedRootCa = (): string => (typeof __ROOT_CA_PEM__ === 'string' ? __ROOT_CA_PEM__ : '')

/** 从 online-data 的多镜像依次取文件；全部失败返回 null */
const fetchFromMirrors = async (path: string): Promise<Uint8Array<ArrayBuffer> | null> => {
  for (const base of TRUST_MIRRORS) {
    const bytes = await requestBytes(base + path)
    if (bytes !== null) {
      return bytes
    }
  }
  return null
}

/** 从页面同源取文件；失败返回 null */
const fetchLocal = async (path: string, base: string): Promise<Uint8Array<ArrayBuffer> | null> => {
  try {
    const response = await fetch(new URL(path, base).href, { cache: 'no-store' })
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null
  } catch {
    return null
  }
}

/** 解析清单；结构不符或路径不合法时返回 null，由调用方静默跳过 */
const parseManifest = (text: string): string[] | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.files)) {
    return null
  }
  const files: string[] = []
  for (const item of parsed.files) {
    if (typeof item !== 'string' || !isLocalPath(item)) {
      return null
    }
    files.push(item)
  }
  return files.length === 0 ? null : files
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

/** 证书链或清单层面的失败：只提示一条，不阻断 */
const warnChain = (): void => {
  showToast({ type: 'error', key: 'webIntegrityChainFailed' })
}

/** 文件签名层面的失败：列出前若干个文件名，只提示一条，不阻断 */
const warnFiles = (failed: readonly string[]): void => {
  const sorted = [...failed].sort()
  const listed = sorted.slice(0, MAX_REPORTED).join(', ')
  const files = sorted.length > MAX_REPORTED ? listed + ' ...' : listed
  showToast({ type: 'error', key: 'webIntegrityFailed', params: { count: sorted.length, files } })
}

/**
 * 静默校验网页产物：根证书 → 网页 EEC 证书链 → 清单签名 → 逐文件签名，只执行一次。
 * 未注入根证书、环境没有 WebCrypto 或网络失败时静默返回；任何校验失败只提示一条警告，不阻断服务。
 */
export const verifyWebIntegrity = async (): Promise<void> => {
  if (started) {
    return
  }
  started = true
  const anchorPem = embeddedRootCa()
  // 本地开发与未注入根证书的构建不做校验，也不加载校验模块
  if (anchorPem.trim() === '') {
    return
  }
  const { ensurePkijsEngine, parseCertificate, parseCrl, verifyCertificateChainWithCrl, verifyDetachedCms } =
    await loadVerifier()
  if (!ensurePkijsEngine()) {
    return
  }
  const anchor = parseCertificate(anchorPem)
  const anchorDer = pemToDer(anchorPem, 'CERTIFICATE')
  if (!anchor || !anchorDer) {
    warnChain()
    return
  }
  // 根证书通过 online-data 分发，必须与内嵌的信任锚逐字节一致
  const publishedRoot = await fetchFromMirrors(ROOT_CA_PATH)
  if (!publishedRoot) {
    return
  }
  const publishedDer = pemToDer(new TextDecoder().decode(publishedRoot), 'CERTIFICATE')
  if (!publishedDer || !derEquals(anchorDer, publishedDer)) {
    warnChain()
    return
  }
  // 网页 EEC 证书必须由根证书签发
  const eecBytes = await fetchFromMirrors(EEC_PATH)
  if (!eecBytes) {
    return
  }
  const eec = parseCertificate(new TextDecoder().decode(eecBytes))
  if (!eec) {
    warnChain()
    return
  }
  // 清单登记了吊销列表时必须拿到并校验 CRL；拿不到或解析失败直接判失败，不静默退化为只校验证书链
  const indexBytes = await fetchFromMirrors(INDEX_FILE)
  const indexText = indexBytes === null ? null : new TextDecoder().decode(indexBytes)
  const crlPath = indexText === null ? null : (parseTrustIndex(indexText)?.crl ?? null)
  let crl: CertificateRevocationList | null = null
  if (crlPath !== null) {
    const crlBytes = await fetchFromMirrors(crlPath)
    crl = crlBytes === null ? null : parseCrl(new TextDecoder().decode(crlBytes))
    if (crl === null) {
      warnChain()
      return
    }
  }
  const chain = await verifyCertificateChainWithCrl(anchor, eec, crl)
  if (!chain.ok) {
    warnChain()
    return
  }
  const base = document.baseURI
  const manifestBytes = await fetchLocal(MANIFEST_FILE, base)
  if (!manifestBytes) {
    return
  }
  const files = parseManifest(new TextDecoder().decode(manifestBytes))
  if (!files) {
    warnChain()
    return
  }
  // 先验证清单签名，再按清单逐个验证文件
  const manifestSignature = await fetchLocal(MANIFEST_FILE + SIGNATURE_SUFFIX, base)
  if (!manifestSignature || !(await verifyDetachedCms(manifestSignature, manifestBytes, eec))) {
    warnChain()
    return
  }
  const results = await mapLimited(files, CONCURRENCY, async (file) => {
    const content = await fetchLocal(file, base)
    if (!content) {
      return false
    }
    const signature = await fetchLocal(file + SIGNATURE_SUFFIX, base)
    if (!signature) {
      return false
    }
    return await verifyDetachedCms(signature, content, eec)
  })
  const failed = files.filter((_, index) => !results[index])
  if (failed.length > 0) {
    warnFiles(failed)
  }
}
