import { showToast } from '../../components/base/toastState.js'
import { fetchTrustListFrom, TRUST_MIRRORS } from './fetch.js'
import type { TrustCollection, TrustList } from './types.js'

/** 空清单；未拉取、未注入公钥或网络失败时都用它 */
const EMPTY: TrustList = { webKeyMatched: false, origin: null, collections: [] }
/** 提示文案里最多列出的合集数量 */
const MAX_REPORTED = 5

let current: TrustList = EMPTY
let inflight: Promise<TrustList> | null = null
let started = false
let warned = false

/**
 * 内嵌的合集信任锚；旧版由构建时注入的 dsc 公钥提供，该注入已随网页签名改造移除。
 * 合集信任迁移到根证书签发的 EEC 证书链后，改由 __ROOT_CA_PEM__ 提供信任锚。
 */
export const embeddedDscKey = (): string => ''

/** 当前清单快照；未拉取过时为空清单 */
export const getTrustList = (): TrustList => current

/** 受信任的合集，含其公钥；不可信条目不在其中 */
export const getTrustedCollections = (): TrustCollection[] =>
  current.collections.filter((item) => item.trust === 'trusted' && item.publicKey !== null)

/** 按合集 id 取受信任的公钥；不可信或缺失时返回 null */
export const getTrustedCollectionKey = (id: string): string | null => {
  const found = getTrustedCollections().find((item) => item.id === id)
  return found?.publicKey ?? null
}

/** 只警告，不改变可用性：公钥不一致与合集不可信都提示用户自行判断 */
const warnOnce = (list: TrustList): void => {
  if (warned) {
    return
  }
  warned = true
  if (!list.webKeyMatched) {
    showToast({ key: 'trustListKeyMismatch' })
    return
  }
  const failed = list.collections.filter((item) => item.trust === 'untrusted')
  if (failed.length === 0) {
    return
  }
  const listed = failed.slice(0, MAX_REPORTED).map((item) => item.id).join(', ')
  const ids = failed.length > MAX_REPORTED ? listed + ' ...' : listed
  showToast({ key: 'trustListCollectionsUntrusted', params: { count: failed.length, ids } })
}

/**
 * 拉取并核对信任清单。
 * 内嵌公钥为空（本地未签名构建）时直接返回空清单且不发起请求；
 * 网络失败或清单结构不符时同样静默返回空清单，不打扰用户。
 */
export const fetchTrustList = async (): Promise<TrustList> => {
  if (inflight) {
    return await inflight
  }
  const dscKey = embeddedDscKey()
  if (dscKey.trim() === '') {
    return EMPTY
  }
  const task = (async (): Promise<TrustList> => {
    for (const base of TRUST_MIRRORS) {
      let list: TrustList | null = null
      try {
        list = await fetchTrustListFrom(base, dscKey)
      } catch {
        list = null
      }
      if (!list) {
        continue
      }
      current = list
      warnOnce(list)
      return list
    }
    return EMPTY
  })()
  inflight = task
  try {
    return await task
  } finally {
    inflight = null
  }
}

/** 启动时静默拉取一次，不阻塞渲染；重复调用只拉一次 */
export const ensureTrustList = (): void => {
  if (started) {
    return
  }
  started = true
  void fetchTrustList()
}

export type { CollectionTrust, TrustCollection, TrustFailureReason, TrustList } from './types.js'
