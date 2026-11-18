import { Certificate, CertificateRevocationList, CryptoEngine, setEngine } from 'pkijs'
import { pemToDer } from './pem.js'

/** 证书链校验结论；reason 只用于排查，不直接展示给用户；revoked 表示失败原因是证书已被吊销 */
export type ChainVerdict = { ok: true } | { ok: false; reason: string; revoked?: boolean }

/** basicConstraints 扩展的 OID */
const BASIC_CONSTRAINTS_OID = '2.5.29.19'
/** keyUsage 扩展的 OID */
const KEY_USAGE_OID = '2.5.29.15'

let engineReady = false

/**
 * 把 pkijs 的密码学运算接到 WebCrypto 上，重复调用只设置一次。
 * 环境没有 WebCrypto 时返回 false，调用方据此静默跳过校验。
 */
export const ensurePkijsEngine = (): boolean => {
  if (engineReady) {
    return true
  }
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return false
  }
  setEngine('webcrypto', new CryptoEngine({ name: 'webcrypto', crypto, subtle: crypto.subtle }))
  engineReady = true
  return true
}

/** 解析 PEM 证书；头尾缺失、DER 非法或 ASN.1 结构不符时返回 null */
export const parseCertificate = (pem: string): Certificate | null => {
  const der = pemToDer(pem, 'CERTIFICATE')
  if (!der) {
    return null
  }
  try {
    return Certificate.fromBER(der)
  } catch {
    return null
  }
}

/** 读取 basicConstraints 的 CA 标志；未声明该扩展时返回 null */
const readCaFlag = (certificate: Certificate): boolean | null => {
  const extension = certificate.extensions?.find((item) => item.extnID === BASIC_CONSTRAINTS_OID)
  if (!extension) {
    return null
  }
  const value = extension.parsedValue as { cA?: unknown } | undefined
  return typeof value?.cA === 'boolean' ? value.cA : null
}

/**
 * keyUsage 的指定位是否为 1；未声明该扩展时返回 false。
 * keyUsage 是 BIT STRING，首个内容字节的最高位是 bit 0。
 */
const hasKeyUsageBit = (certificate: Certificate, mask: number): boolean => {
  const extension = certificate.extensions?.find((item) => item.extnID === KEY_USAGE_OID)
  const value = extension?.parsedValue as
    | { valueBlock?: { valueHexView?: Uint8Array } }
    | undefined
  const bytes = value?.valueBlock?.valueHexView
  return bytes !== undefined && bytes.length > 0 && (bytes[0] & mask) !== 0
}

/** digitalSignature 是 bit 0，即首个内容字节的 0x80 位 */
const hasDigitalSignature = (certificate: Certificate): boolean =>
  hasKeyUsageBit(certificate, 0x80)

/** cRLSign 是 bit 6，即首个内容字节的 0x02 位；签发吊销列表的根证书必须带这一位 */
const hasCrlSign = (certificate: Certificate): boolean => hasKeyUsageBit(certificate, 0x02)

/** 证书在给定时刻是否处于有效期内 */
const withinValidity = (certificate: Certificate, now: Date): boolean =>
  certificate.notBefore.value.getTime() <= now.getTime() &&
  now.getTime() <= certificate.notAfter.value.getTime()

/**
 * 校验证书链：EEC 由根证书签发。
 * 检查项为签发者与主体匹配、两端都在有效期内、根证书声明 CA:TRUE、EEC 的签名可用根证书公钥验证、
 * EEC 的 keyUsage 含 digitalSignature、EEC 不是 CA。任何一项不满足都返回失败原因，不抛出异常。
 */
export const verifyCertificateChain = async (
  root: Certificate,
  eec: Certificate,
  now: Date = new Date()
): Promise<ChainVerdict> => {
  if (!eec.issuer.isEqual(root.subject)) {
    return { ok: false, reason: 'EEC 的签发者与根证书主体不一致' }
  }
  if (!withinValidity(root, now)) {
    return { ok: false, reason: '根证书不在有效期内' }
  }
  if (!withinValidity(eec, now)) {
    return { ok: false, reason: 'EEC 不在有效期内' }
  }
  if (readCaFlag(root) !== true) {
    return { ok: false, reason: '根证书未声明 basicConstraints CA:TRUE' }
  }
  let signed = false
  try {
    signed = await eec.verify(root)
  } catch {
    signed = false
  }
  if (!signed) {
    return { ok: false, reason: 'EEC 的签名无法用根证书公钥验证' }
  }
  if (!hasDigitalSignature(eec)) {
    return { ok: false, reason: 'EEC 的 keyUsage 不含 digitalSignature' }
  }
  if (readCaFlag(eec) !== false) {
    return { ok: false, reason: 'EEC 必须是终端证书，不能声明 CA:TRUE' }
  }
  return { ok: true }
}

/** CRL 的 PEM 头标签；openssl ca -gencrl 输出 X509 CRL */
const CRL_PEM_LABEL = 'X509 CRL'

/** ASN.1 INTEGER 的最小结构；证书序列号与 CRL 条目序列号都按它取字节 */
type Asn1Integer = { valueBlock?: { valueHexView?: Uint8Array } }

/**
 * 序列号转成大写十六进制。
 * 先去前导零字节，保证同一整数在不同编码下得到同一个字符串。
 */
const serialHex = (value: Asn1Integer): string => {
  const bytes = value.valueBlock?.valueHexView
  if (bytes === undefined || bytes.length === 0) {
    return ''
  }
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start += 1
  }
  let text = ''
  for (let index = start; index < bytes.length; index += 1) {
    text += bytes[index].toString(16).padStart(2, '0')
  }
  return text.toUpperCase()
}

/** CRL 摘要：被吊销序列号与本次、下次更新时间 */
export type CrlSummary = {
  /** 被吊销证书的序列号，大写十六进制 */
  revoked: string[]
  /** 本次更新时间 */
  thisUpdate: Date
  /** 下次更新时间；CRL 未声明时为 null */
  nextUpdate: Date | null
}

/** 解析 PEM 形式的 CRL；头尾缺失、DER 非法或 ASN.1 结构不符时返回 null */
export const parseCrl = (pem: string): CertificateRevocationList | null => {
  const der = pemToDer(pem, CRL_PEM_LABEL)
  if (!der) {
    return null
  }
  try {
    return CertificateRevocationList.fromBER(der)
  } catch {
    return null
  }
}

/** 取 CRL 的吊销序列号与时间窗口 */
export const summarizeCrl = (crl: CertificateRevocationList): CrlSummary => ({
  revoked: (crl.revokedCertificates ?? [])
    .map((entry) => serialHex(entry.userCertificate))
    .filter((serial) => serial !== ''),
  thisUpdate: crl.thisUpdate.value,
  nextUpdate: crl.nextUpdate === undefined ? null : crl.nextUpdate.value,
})

/**
 * 证书是否被该 CRL 吊销。
 * 只比较序列号，不判断 CRL 本身是否有效，CRL 的有效性由 verifyCrl 负责。
 */
export const isRevoked = (certificate: Certificate, crl: CertificateRevocationList): boolean => {
  const target = serialHex(certificate.serialNumber)
  if (target === '') {
    return false
  }
  return (crl.revokedCertificates ?? []).some(
    (entry) => serialHex(entry.userCertificate) === target
  )
}

/**
 * 校验 CRL 本身：由给定根证书签发、当前时间落在本次更新与下次更新之间、签名可用根证书公钥验证。
 * 任何一项不满足都返回失败原因，不抛出异常。
 */
export const verifyCrl = async (
  crl: CertificateRevocationList,
  root: Certificate,
  now: Date = new Date()
): Promise<ChainVerdict> => {
  if (!hasCrlSign(root)) {
    return { ok: false, reason: '根证书的 keyUsage 不含 cRLSign，不能签发吊销列表' }
  }
  if (!crl.issuer.isEqual(root.subject)) {
    return { ok: false, reason: 'CRL 的签发者与根证书主体不一致' }
  }
  if (crl.nextUpdate === undefined) {
    return { ok: false, reason: 'CRL 未声明下次更新时间，无法判断是否过期' }
  }
  if (now.getTime() < crl.thisUpdate.value.getTime()) {
    return { ok: false, reason: 'CRL 尚未生效' }
  }
  if (now.getTime() > crl.nextUpdate.value.getTime()) {
    return { ok: false, reason: 'CRL 已过期' }
  }
  let signed = false
  try {
    signed = await crl.verify({ issuerCertificate: root })
  } catch {
    signed = false
  }
  if (!signed) {
    return { ok: false, reason: 'CRL 的签名无法用根证书公钥验证' }
  }
  return { ok: true }
}

/**
 * 校验证书链并按需做吊销检查。
 * crl 为 null 时只校验证书链；给出 CRL 时先校验 CRL 本身，再检查 EEC 是否被吊销，
 * 被吊销时返回带 revoked 标记的失败结论，供调用方给出「证书已被吊销」的文案。
 */
export const verifyCertificateChainWithCrl = async (
  root: Certificate,
  eec: Certificate,
  crl: CertificateRevocationList | null,
  now: Date = new Date()
): Promise<ChainVerdict> => {
  const chain = await verifyCertificateChain(root, eec, now)
  if (!chain.ok) {
    return chain
  }
  if (crl === null) {
    return { ok: true }
  }
  const crlVerdict = await verifyCrl(crl, root, now)
  if (!crlVerdict.ok) {
    return crlVerdict
  }
  if (isRevoked(eec, crl)) {
    return { ok: false, reason: 'EEC 证书已被吊销', revoked: true }
  }
  return { ok: true }
}
