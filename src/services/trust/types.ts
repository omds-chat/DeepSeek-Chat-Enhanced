/** 合集信任结论；untrusted 表示 EEC 证书链校验未通过或材料缺失 */
export type CollectionTrust = 'trusted' | 'untrusted'

/**
 * 合集不可信的原因。
 * missing 表示清单登记或证书文件缺失，chain 表示证书链校验未通过，revoked 表示 EEC 证书已被吊销。
 */
export type TrustFailureReason = 'missing' | 'chain' | 'revoked'

/** 信任清单中的单个合集；不可信的条目同样列出，只是不给证书 */
export type TrustCollection = {
  id: string
  /** 合集 EEC 证书 PEM；不可信时为 null，避免被当作可信证书使用 */
  eec: string | null
  trust: CollectionTrust
  /** 不可信的原因；可信时为 null */
  reason: TrustFailureReason | null
}

/** 一次核对得到的信任清单快照 */
export type TrustList = {
  /** 拉取到的根证书与内嵌的根证书是否一致；不一致时清单不被采信 */
  rootMatched: boolean
  /** 实际生效的清单来源地址；未拉到时为 null */
  origin: string | null
  /** 拉取到的根证书 PEM；未拉到时为 null */
  rootCa: string | null
  /** 吊销列表在清单内的相对路径；没有时为 null */
  crl: string | null
  /** 清单里的合集，含不可信条目 */
  collections: TrustCollection[]
}
