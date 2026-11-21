import { showToast } from '../../components/base/toastState.js'
import { CERT_MIRRORS, fetchTrustListFrom, TRUST_MANIFEST_MIRRORS } from './fetch.js'
import type { TrustCollection, TrustList } from './types.js'

/** 空清单；未拉取、未注入根证书或网络失败时都用它 */
const EMPTY: TrustList = { rootMatched: false, origin: null, rootCa: null, crl: null, collections: [] }
/** 提示文案里最多列出的合集数量 */
const MAX_REPORTED = 5

let current: TrustList = EMPTY
let inflight: Promise<TrustList> | null = null
let started = false
let warned = false

/** 构建时注入的根证书 PEM；未注入时为空串 */
export const embeddedRootPem = (): string =>
  typeof __ROOT_CA_PEM__ === 'string' ? __ROOT_CA_PEM__ : ''

/** 当前清单快照；未拉取过时为空清单 */
export const getTrustList = (): TrustList => current

/** 按合集 id 取信任结论；清单里没有该合集时返回 null */
export const getCollectionTrust = (id: string): TrustCollection | null =>
  current.collections.find((item) => item.id === id) ?? null

/** 只警告，不改变可用性：根证书不一致与合集不可信都提示用户自行判断 */
const warnOnce = (list: TrustList): void => {
  if (warned) {
    return
  }
  warned = true
  if (!list.rootMatched) {
    showToast({ key: 'trustListRootMismatch' })
    return
  }
  const failed = list.collections.filter((item) => item.trust === 'untrusted')
  if (failed.length === 0) {
    return
  }
  const listed = failed.slice(0, MAX_REPORTED).map((item) => item.id).join(', ')
  const ids = failed.length > MAX_REPORTED ? listed + ' ...' : listed
  // 证书被吊销与证书链校验失败分开提示，便于用户判断原因
  const key = failed.some((item) => item.reason === 'revoked')
    ? 'trustListCollectionsRevoked'
    : 'trustListCollectionsUntrusted'
  showToast({ key, params: { count: failed.length, ids } })
}

/**
 * 拉取并核对信任清单。
 * 内嵌根证书为空（本地未签名构建）时直接返回空清单且不发起请求；
 * 网络失败或清单结构不符时同样静默返回空清单，不打扰用户。
 */
export const fetchTrustList = async (): Promise<TrustList> => {
  if (inflight) {
    return await inflight
  }
  const rootPem = embeddedRootPem()
  if (rootPem.trim() === '') {
    return EMPTY
  }
  const task = (async (): Promise<TrustList> => {
    // 清单与证书分属两条并行分支，两个镜像列表按下标一一对应
    for (let index = 0; index < TRUST_MANIFEST_MIRRORS.length; index += 1) {
      const manifestBase = TRUST_MANIFEST_MIRRORS[index]
      const certBase = CERT_MIRRORS[index] ?? manifestBase
      let list: TrustList | null = null
      try {
        list = await fetchTrustListFrom(manifestBase, certBase, rootPem)
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
