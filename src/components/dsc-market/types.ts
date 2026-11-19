import type { TranslationKey } from '../../i18n/index.js'
import type { PluginManifest, PluginSourceType } from '../dsc-plugin-engine/types.js'

/**
 * 来源信任状态。
 * trusted 由合集 EEC 证书链校验通过；endorsed 表示来源由 dsc 直接背书，即 dsc 内部插件索引，
 * 不依赖合集 EEC 链但仍走与外部来源完全一致的安装校验；untrusted 为证书链校验未通过；
 * unverified 表示 online-data 信任清单里没有该来源，或构建未注入根证书。
 */
export type SourceTrust = 'trusted' | 'endorsed' | 'untrusted' | 'unverified'

/**
 * 信任失败原因。
 * missing 表示清单登记或证书文件缺失，chain 表示证书链校验未通过，revoked 表示 EEC 证书已被吊销。
 */
export type TrustFailure = 'missing' | 'chain' | 'revoked'

/** 用户可配置的来源；base_url 按顺序尝试 */
export type MarketSource = {
  id: string
  name: string
  baseUrls: string[]
  /** 内置来源不可删除 */
  builtin: boolean
}

/** 来源 meta.json 的下载计数配置；缺失字段按关闭处理 */
export type SourceMeta = {
  downloadCountEnabled: boolean
  downloadCountApi: string
  apiNeedIp: boolean
}

/** 双语文案；缺失的一侧用另一侧补 */
export type LocalizedText = { 'zh-CN': string; 'en-US': string }

/** 运行时 meta.json 的可展示子集 */
export type RuntimeMeta = {
  name: string
  version: string
  license: string
  author: string
  description: LocalizedText
  repoLink: string
  homePage: string
}

/** 目录中的一个插件 */
export type CatalogPlugin = {
  /** 合集内唯一键，形如 author/name */
  key: string
  name: string
  author: string
  tags: string[]
  /** 最新版本号；versions.json 缺失时为 null */
  latest: string | null
  versions: string[]
  meta: RuntimeMeta | null
  /** 由 meta.json 推导的清单；缺 capabilities 时为 null，安装时交给产物自带的 manifest */
  manifest: PluginManifest | null
  /** 拉取失败或结构不符时的文案键 */
  error: TranslationKey | null
}

/** 来源运行态 */
export type SourceRuntime = {
  id: string
  state: 'idle' | 'loading' | 'ready' | 'failed'
  /** 实际生效的 base_url */
  baseUrl: string | null
  trust: SourceTrust
  trustFailure: TrustFailure | null
  meta: SourceMeta | null
  /** 该来源的合集 EEC 证书 PEM；来自 online-data 信任清单，未列入清单时为 null */
  eec: string | null
  /** 证书来自 online-data 信任清单，而不是来源自己分发的 eec.pem */
  eecFromTrustList: boolean
  /** 合集 EEC 证书链是否校验通过；endorsed 来源为 false 时表示只有 dsc 背书这一层判定 */
  chainVerified: boolean
  plugins: CatalogPlugin[]
  fetchedAt: number | null
  /** 结构不符被跳过的插件数 */
  skipped: number
  error: TranslationKey | null
}

/**
 * 安装计划；交给引擎的 installFromUrl。
 * eec 只来自 online-data 信任清单；没有清单证书时计划里没有 eec，引擎跳过 CMS 验签并把来源结论记为 unknown，
 * 来源站点自带的 eec.pem 不作为验签依据。
 */
export type InstallPlan = {
  /** plugin.js 地址 */
  url: string
  /** 该版本目录的地址,安装时入库,后续直接按它请求 versions.json、meta.json */
  dataBase: string
  /** 插件目录的地址,安装时入库,用于取 versions.json */
  pluginBase: string
  manifest?: PluginManifest
  sourceType: PluginSourceType
  /** 合集 EEC 证书 PEM；只来自 online-data 信任清单 */
  eec?: string
  /** plugin.js.sig 地址，CMS 分离签名 */
  sigUrl: string
  /** 作者公钥地址，作者裸签名为可选材料 */
  authorPubUrl: string
  /** 作者签名地址 */
  authorSigUrl: string
}

/** 更新检查的目标；dataBase 优先，缺失时由 sourceUrl 推导 */
export type UpdateTarget = {
  /** 已安装插件的 id */
  id: string
  /** 本地清单里的版本号 */
  version: string
  /** 安装记录里登记的数据基址（版本目录）；旧记录没有该字段 */
  dataBase?: string
  /** 安装记录里的 plugin.js 地址 */
  sourceUrl?: string
}

/** 更新检查结论；latest 是来源 versions.json 给出的最新版本号 */
export type UpdateCheck = {
  status: 'outdated' | 'latest'
  latest: string
}

/** 更新检查报告；无法判断（无来源、请求失败、版本号不合法）的插件不出现在报告里 */
export type UpdateReport = Map<string, UpdateCheck>

/** 重新安装计划；来源信任判定一并给出，供引擎区分来源结论 */
export type ReinstallPlan = {
  plan: InstallPlan
  /** 同址来源的信任判定；找不到同址来源时为 null */
  trust: SourceTrust | null
  trustFailure: TrustFailure | null
}
