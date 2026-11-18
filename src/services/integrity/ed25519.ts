import * as ed from '@noble/ed25519'

/** Ed25519 原始公钥字节数 */
const PUBLIC_KEY_LENGTH = 32
/** Ed25519 签名字节数（R || S） */
const SIGNATURE_LENGTH = 64

/** SHA-512 摘要，接入 WebCrypto */
export const sha512 = async (data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.digest('SHA-512', new Uint8Array(data)))

/** 验签库的异步哈希路径接到 WebCrypto 上，不额外引入哈希实现 */
ed.hashes.sha512Async = sha512

/**
 * 验证 Ed25519 签名。
 * signature 为 64 字节（R || S），publicKey 为 32 字节原始公钥，message 为被签名数据。
 * 长度不符、点解码失败等非法输入一律返回 false，不抛出异常。
 */
export const verifyEd25519 = async (
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): Promise<boolean> => {
  if (signature.length !== SIGNATURE_LENGTH || publicKey.length !== PUBLIC_KEY_LENGTH) {
    return false
  }
  try {
    return await ed.verifyAsync(signature, message, publicKey)
  } catch {
    return false
  }
}

/** SPKI 前缀：SEQUENCE(42) / SEQUENCE(5) / OID 1.3.101.112 / BIT STRING(33) / 填充 0 */
const SPKI_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]

/**
 * 从 SPKI PEM 公钥取出 32 字节原始公钥。
 * 非 PEM、截断 PEM、DER 长度不符、OID 不是 Ed25519 时返回 null。
 */
export const readPublicKey = (pem: string): Uint8Array | null => {
  const match = /-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----/.exec(pem)
  if (!match) {
    return null
  }
  const base64 = match[1].replace(/\s+/g, '')
  let der: Uint8Array
  try {
    const binary = atob(base64)
    der = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      der[index] = binary.charCodeAt(index)
    }
  } catch {
    return null
  }
  if (der.length !== SPKI_PREFIX.length + PUBLIC_KEY_LENGTH) {
    return null
  }
  for (let index = 0; index < SPKI_PREFIX.length; index += 1) {
    if (der[index] !== SPKI_PREFIX[index]) {
      return null
    }
  }
  return der.subarray(SPKI_PREFIX.length)
}

/** base64 文本转字节；非法输入返回 null */
export const base64ToBytes = (value: string): Uint8Array | null => {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

/** 字节转 base64；用于把 DER 签名存进只接受文本的存储位置 */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/**
 * 校验裸 Ed25519 分离签名：signature 为 64 字节签名，message 为被签名的原始字节。
 * 公钥或签名非法、验签失败都返回 false，不抛出异常。
 */
export const verifyDetachedSignature = async (
  message: Uint8Array,
  signature: Uint8Array,
  publicKeyPem: string
): Promise<boolean> => {
  const publicKey = readPublicKey(publicKeyPem)
  if (!publicKey) {
    return false
  }
  return await verifyEd25519(signature, message, publicKey)
}
