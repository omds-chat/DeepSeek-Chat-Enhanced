/**
 * 网页签名材料的选取。
 * 在线副本只作备选：根证书永远用构建内嵌的那份，在线副本只做比对；
 * 网页签名 EEC 在线优先，但必须先在内嵌根证书下通过证书链校验，链不通过不得使用；
 * CRL 在线时取并验签，离线或取不到时吊销状态按未知处理，不阻断任何操作。
 */
import type { Certificate, CertificateRevocationList } from 'pkijs'
import { parseTrustIndex, TRUST_MIRRORS } from '../trust/fetch.js'
import { isOnline, logMaterial, requestBytes } from '../trust/net.js'
import { derEquals, pemToDer } from './pem.js'

/** online-data 上的根证书路径；与构建内嵌的是同一份，只用于比对 */
export const ROOT_CA_PATH = 'certs/ds-chat/ds-chat-root-ca.crt'
/** online-data 上的网页签名 EEC 证书路径 */
export const PAGES_EEC_PATH = 'certs/ds-chat-pages/ds-chat-pages-eec.crt'
/** online-data 上的信任清单路径，只用来取吊销列表的登记 */
const INDEX_FILE = 'index.json'

/** 材料来源：online 表示在线副本，embedded 表示构建内嵌，unavailable 表示都没有 */
export type MaterialOrigin = 'online' | 'embedded' | 'unavailable'

/** online-data 的根证书与内嵌根证书的比对结论 */
export type PublishedRootOutcome = 'matched' | 'mismatched' | 'missing' | 'offline'

/** 网页签名 EEC 的选取结果 */
export type PagesEecSelection = {
  /** 用于 CMS 验签的 EEC 证书 PEM；两份都拿不到时为空串 */
  pem: string
  origin: MaterialOrigin
}

/** 构建时注入的网页签名 EEC 证书 PEM；未注入时为空串 */
export const embeddedPagesEecPem = (): string =>
  typeof __PAGES_EEC_PEM__ === 'string' ? __PAGES_EEC_PEM__ : ''

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** 从 online-data 的多镜像依次取单个文件；离线、地址全失败都返回 null */
export const fetchOnlineMaterial = async (
  path: string
): Promise<Uint8Array<ArrayBuffer> | null> => {
  for (const base of TRUST_MIRRORS) {
    const bytes = await requestBytes(base + path)
    if (bytes !== null) {
      return bytes
    }
  }
  return null
}

/**
 * 比对 online-data 的根证书与构建内嵌的根证书。
 * 只做比对与告警：信任锚永远是构建内嵌的那份，比对结论不参与任何决策。
 * 离线时直接返回 offline，不发请求。
 */
export const comparePublishedRoot = async (
  embeddedDer: Uint8Array
): Promise<PublishedRootOutcome> => {
  if (!isOnline()) {
    logMaterial('integrity', '当前离线，不拉取 online-data 的根证书副本，按构建内嵌的根证书校验')
    return 'offline'
  }
  const bytes = await fetchOnlineMaterial(ROOT_CA_PATH)
  if (bytes === null) {
    logMaterial('integrity', 'online-data 缺少 ' + ROOT_CA_PATH + '，按构建内嵌的根证书校验')
    return 'missing'
  }
  const publishedDer = pemToDer(decode(bytes), 'CERTIFICATE')
  if (publishedDer === null || !derEquals(embeddedDer, publishedDer)) {
    logMaterial(
      'integrity',
      'online-data 的 ' + ROOT_CA_PATH + ' 与构建内嵌的根证书不一致，按构建内嵌的根证书校验'
    )
    return 'mismatched'
  }
  return 'matched'
}

/**
 * 选取网页签名用的 EEC 证书。
 * 离线时直接用构建内嵌的那份，一个请求都不发；
 * 在线时先取 online-data 的副本，必须能解析且能在内嵌根证书下通过证书链校验，
 * 取不到、解析失败或链不通过时回退内嵌，并留一条提示说明当前用的是内嵌材料。
 */
export const selectPagesEec = async (anchor: Certificate): Promise<PagesEecSelection> => {
  const embedded = embeddedPagesEecPem().trim()
  const fallback = (reason: string): PagesEecSelection => {
    logMaterial('integrity', reason + '，改用构建内嵌的网页签名 EEC 证书')
    return { pem: embedded, origin: embedded === '' ? 'unavailable' : 'embedded' }
  }
  if (!isOnline()) {
    logMaterial('integrity', '当前离线，网页签名使用构建内嵌的 EEC 证书')
    return { pem: embedded, origin: embedded === '' ? 'unavailable' : 'embedded' }
  }
  const bytes = await fetchOnlineMaterial(PAGES_EEC_PATH)
  if (bytes === null) {
    return fallback('online-data 上没有取到 ' + PAGES_EEC_PATH)
  }
  const { parseCertificate, verifyCertificateChain } = await import('./x509.js')
  const online = parseCertificate(decode(bytes))
  if (online === null) {
    return fallback('online-data 的 ' + PAGES_EEC_PATH + ' 无法解析')
  }
  if (!(await verifyCertificateChain(anchor, online)).ok) {
    return fallback('online-data 的 ' + PAGES_EEC_PATH + ' 在内嵌根证书下证书链校验未通过')
  }
  return { pem: decode(bytes), origin: 'online' }
}

/**
 * 选取吊销列表。
 * 在线时按信任清单登记的路径取 CRL，并用内嵌根证书验签；
 * 离线、清单没有登记、取不到、无法解析或验签不通过都返回 null，
 * 表示吊销状态未知：既不据此判定任何证书已吊销，也不阻断后续操作。
 */
export const selectWebCrl = async (
  anchor: Certificate
): Promise<CertificateRevocationList | null> => {
  if (!isOnline()) {
    logMaterial('integrity', '当前离线，吊销状态未知，跳过吊销检查')
    return null
  }
  const indexBytes = await fetchOnlineMaterial(INDEX_FILE)
  const crlPath = indexBytes === null ? null : (parseTrustIndex(decode(indexBytes))?.crl ?? null)
  if (crlPath === null) {
    return null
  }
  const crlBytes = await fetchOnlineMaterial(crlPath)
  if (crlBytes === null) {
    logMaterial('integrity', 'online-data 上没有取到 ' + crlPath + '，吊销状态未知，跳过吊销检查')
    return null
  }
  const { parseCrl, verifyCrl } = await import('./x509.js')
  const crl = parseCrl(decode(crlBytes))
  if (crl === null) {
    logMaterial('integrity', 'online-data 的 ' + crlPath + ' 无法解析，吊销状态未知，跳过吊销检查')
    return null
  }
  const verdict = await verifyCrl(crl, anchor)
  if (!verdict.ok) {
    logMaterial(
      'integrity',
      'online-data 的 ' + crlPath + ' 未通过内嵌根证书验签：' + verdict.reason + '，吊销状态未知，跳过吊销检查'
    )
    return null
  }
  return crl
}
