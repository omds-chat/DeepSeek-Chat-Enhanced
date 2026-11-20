import { collectionIdOf } from '../../services/trust/collection.js'
import { getCollectionTrust } from '../../services/trust/index.js'
import type { MarketSource, SourceTrust, TrustFailure } from './types.js'

/** dsc 直接背书的内部插件索引；这些来源不走合集 EEC 链判定 */
export const ENDORSED_SOURCE_IDS: readonly string[] = ['dsc-inner-plugin']

/**
 * 是否 dsc 背书的来源。
 * 只有内置来源才可能是背书来源：用户自建的来源即使同名也不按背书处理，避免伪造背书。
 */
export const isEndorsedSource = (source: MarketSource): boolean =>
  source.builtin && ENDORSED_SOURCE_IDS.includes(source.id)

/** 来源信任判定结果；只用于界面展示来源是否被官方认可，不参与来源结论判定 */
export type SourceTrustOutcome = {
  trust: SourceTrust
  trustFailure: TrustFailure | null
  /** 信任清单登记的 EEC 证书 PEM；未列入清单时为 null，登记时优先用它省一次请求 */
  eec: string | null
  /** 证书来自 online-data 信任清单，而不是来源自己分发的文件 */
  eecFromTrustList: boolean
  /** 清单登记的 EEC 证书链是否校验通过；引擎安装时还会用内置根 CA 重做一次 */
  chainVerified: boolean
  /** 合集 id：清单登记的 id 优先，其次清单登记的目录名，最后用站点名归一化 */
  collectionId: string
}

/**
 * 判定来源信任。
 * 信任清单是策略层：登记与背书只用于界面展示来源是否被官方认可，来源结论由引擎按本机证书链与验签给出。
 * 社区来源：从 online-data 的 index.json 里按来源 id 与名称查找合集，找到且证书链校验通过即可信，
 * 找到但链校验不通过或证书缺失记为不可信；清单里没有该来源时记为未校验，只警告不阻断。
 * inner 来源：以「dsc 直接背书」为准，不依赖合集 EEC 链；清单里登记了它的 EEC 时仍按证书链校验，
 * 两种判定都通过才记为背书来源，链校验不通过仍记为不可信，都拿不到时退回未校验。
 */
export const resolveSourceTrust = (source: MarketSource): SourceTrustOutcome => {
  const listed = getCollectionTrust(source.id) ?? getCollectionTrust(source.name)
  const collectionId = collectionIdOf(listed, source.name)
  if (isEndorsedSource(source)) {
    if (!listed) {
      // 只有 dsc 背书这一层判定；安装时仍由引擎按来源 certs 布局的嵌套、扁平与 eec.pem 三档取证书验签
      return {
        trust: 'endorsed',
        trustFailure: null,
        eec: null,
        eecFromTrustList: false,
        chainVerified: false,
        collectionId,
      }
    }
    if (listed.trust === 'trusted' && listed.eec !== null) {
      // 背书与证书链都通过；证书仍按清单里的用，安装流程与其他来源一致
      return {
        trust: 'endorsed',
        trustFailure: null,
        eec: listed.eec,
        eecFromTrustList: true,
        chainVerified: true,
        collectionId,
      }
    }
    return {
      trust: 'untrusted',
      trustFailure: listed.reason ?? 'chain',
      eec: null,
      eecFromTrustList: false,
      chainVerified: false,
      collectionId,
    }
  }
  if (!listed) {
    return {
      trust: 'unverified',
      trustFailure: null,
      eec: null,
      eecFromTrustList: false,
      chainVerified: false,
      collectionId,
    }
  }
  if (listed.trust === 'trusted' && listed.eec !== null) {
    return {
      trust: 'trusted',
      trustFailure: null,
      eec: listed.eec,
      eecFromTrustList: true,
      chainVerified: true,
      collectionId,
    }
  }
  return {
    trust: 'untrusted',
    trustFailure: listed.reason ?? 'chain',
    eec: null,
    eecFromTrustList: false,
    chainVerified: false,
    collectionId,
  }
}
