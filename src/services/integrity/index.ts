import { showToast } from '../../components/base/toastState.js'
import { base64ToBytes, readPublicKey, sha512, verifyEd25519 } from './ed25519.js'

/** 签名清单文件名，与 index.html 同目录 */
const SIGN_FILE = 'web_sign.json'
/** 并行拉取文件的上限 */
const CONCURRENCY = 6
/** 提示文案中最多列出的文件名数量 */
const MAX_REPORTED = 5

/** 签名清单中的一条记录 */
type SignEntry = { value: string; for: string; signer: string }

let started = false

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 解析签名清单；结构不符时返回 null，由调用方静默跳过 */
const parseSignList = (text: string): SignEntry[] | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.sign)) {
    return null
  }
  const entries: SignEntry[] = []
  for (const item of parsed.sign) {
    if (!isRecord(item)) {
      return null
    }
    const { value, signer } = item
    const target = item.for
    if (typeof value !== 'string' || typeof target !== 'string' || typeof signer !== 'string') {
      return null
    }
    entries.push({ value, for: target, signer })
  }
  return entries
}

/** 只接受相对路径，避免清单把校验指向站外地址 */
const isLocalPath = (value: string): boolean =>
  value !== '' &&
  !value.startsWith('/') &&
  !value.includes('..') &&
  !/^[a-z][a-z0-9+.-]*:/i.test(value)

const fetchBytes = async (url: string): Promise<Uint8Array | null> => {
  try {
    const response = await fetch(url)
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null
  } catch {
    return null
  }
}

/** 校验单条签名：拉取文件字节，比对 SHA-512 摘要并验证 Ed25519 签名 */
const verifyEntry = async (
  entry: SignEntry,
  publicKey: Uint8Array,
  base: string
): Promise<boolean> => {
  try {
    if (!isLocalPath(entry.for)) {
      return false
    }
    const signature = base64ToBytes(entry.value)
    if (!signature) {
      return false
    }
    const bytes = await fetchBytes(new URL(entry.for, base).href)
    if (!bytes) {
      return false
    }
    return await verifyEd25519(signature, await sha512(bytes), publicKey)
  } catch {
    return false
  }
}

/**
 * 静默校验网页文件签名，只执行一次。
 * 未注入公钥时直接返回；清单拉取失败时静默返回；校验失败只提示一条警告，不阻断服务。
 */
export const verifyWebIntegrity = async (): Promise<void> => {
  if (started) {
    return
  }
  started = true
  // 本地开发与未签名的构建不注入公钥，此时跳过校验
  if (!__WEB_PUBLIC_KEY__ || typeof crypto === 'undefined' || !crypto.subtle) {
    return
  }
  const publicKey = readPublicKey(__WEB_PUBLIC_KEY__)
  if (!publicKey) {
    return
  }
  const base = document.baseURI
  let text: string
  try {
    const response = await fetch(new URL(SIGN_FILE, base).href)
    if (!response.ok) {
      return
    }
    text = await response.text()
  } catch {
    return
  }
  const entries = parseSignList(text)
  if (!entries || entries.length === 0) {
    return
  }
  const failed: string[] = []
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < entries.length) {
      const entry = entries[cursor]
      cursor += 1
      if (!(await verifyEntry(entry, publicKey, base))) {
        failed.push(entry.for)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker))
  if (failed.length === 0) {
    return
  }
  failed.sort()
  const listed = failed.slice(0, MAX_REPORTED).join(', ')
  const files = failed.length > MAX_REPORTED ? listed + ' ...' : listed
  showToast({ type: 'error', key: 'webIntegrityFailed', params: { count: failed.length, files } })
}
