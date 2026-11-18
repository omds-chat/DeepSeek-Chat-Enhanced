import { getCollectionTrust } from '../../services/trust/index.js'
import type { MarketSource, SourceTrust, TrustFailure } from './types.js'

/** 来源信任判定结果；eec 是可用于 CMS 验签的合集证书 */
export type SourceTrustOutcome = {
  trust: SourceTrust
  trustFailure: TrustFailure | null
  /** 来自 online-data 信任清单的 EEC 证书 PEM；未列入清单时为 null */
  eec: string | null
  /** 证书来自 online-data 信任清单，而不是来源自己分发的文件 */
  eecFromTrustList: boolean
}

/**
 * 判定来源信任。
 * 从 online-data 的 index.json 里按来源 id 与名称查找合集：找到且证书链校验通过即可信，
 * 找到但链校验不通过或证书缺失记为不可信；清单里没有该来源时记为未校验，只警告不阻断。
 */
export const resolveSourceTrust = (source: MarketSource): SourceTrustOutcome => {
  const listed = getCollectionTrust(source.id) ?? getCollectionTrust(source.name)
  if (!listed) {
    return { trust: 'unverified', trustFailure: null, eec: null, eecFromTrustList: false }
  }
  if (listed.trust === 'trusted' && listed.eec !== null) {
    return { trust: 'trusted', trustFailure: null, eec: listed.eec, eecFromTrustList: true }
  }
  return {
    trust: 'untrusted',
    trustFailure: listed.reason ?? 'chain',
    eec: null,
    eecFromTrustList: false,
  }
}
