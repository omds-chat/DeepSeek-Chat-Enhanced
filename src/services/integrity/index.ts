import { showToast } from '../../components/base/toastState.js'
import { comparePublishedRoot, selectPagesEec, selectWebCrl } from './material.js'
import { pemToDer } from './pem.js'

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
 * 根证书只用构建内嵌的那份，certs 分支的同名副本只做比对；网页 EEC 在线优先，
 * 但必须在内嵌根证书下通过证书链校验，取不到或链不通过时回退内嵌；
 * 吊销列表离线或取不到时按吊销状态未知处理，不阻断校验。
 * 未注入根证书、环境没有 WebCrypto 或产物缺少清单时静默返回；任何校验失败只提示一条警告，不阻断服务。
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
  const { ensurePkijsEngine, parseCertificate, verifyCertificateChainWithCrl, verifyDetachedCms } =
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
  // 根证书只比对不采用：不一致时仍按内嵌的那份校验，在线副本不参与任何决策
  await comparePublishedRoot(anchorDer)
  // 网页 EEC 在线优先并要求在内嵌根证书下通过链校验，离线与失败回退内嵌
  const selection = await selectPagesEec(anchor)
  const eec = selection.pem === '' ? null : parseCertificate(selection.pem)
  if (!eec) {
    warnChain()
    return
  }
  // 吊销列表离线或不可用时按吊销状态未知处理，不据此阻断校验
  const crl = await selectWebCrl(anchor)
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
  if (!manifestSignature || !(await verifyDetachedCms(manifestSignature, manifestBytes, eec, anchor))) {
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
    return await verifyDetachedCms(signature, content, eec, anchor)
  })
  const failed = files.filter((_, index) => !results[index])
  if (failed.length > 0) {
    warnFiles(failed)
  }
}
