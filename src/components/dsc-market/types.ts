import type { TranslationKey } from '../../i18n/index.js'
import type { ManifestRevisions } from '../../services/integrity/manifest.js'
import type { PluginManifest, PluginSourceType } from '../dsc-plugin-engine/types.js'
import type { SourceModel } from './model.js'

/**
 * 来源信任状态；只表示 trusted-manifest 信任清单是否登记并认可该来源,不参与来源结论判定。
 * trusted 表示清单登记了该来源的 EEC 且证书链校验通过；endorsed 表示来源由 dsc 直接背书，
 * 即 dsc 内部插件索引；untrusted 表示清单登记了但证书链校验未通过；
 * unverified 表示清单里没有该来源，或构建未注入根证书。
 */
export type SourceTrust = 'trusted' | 'endorsed' | 'untrusted' | 'unverified'

/**
 * 信任失败原因。
 * missing 表示清单登记或证书文件缺失，chain 表示证书链校验未通过，revoked 表示 EEC 证书已被吊销。
 */
export type TrustFailure = 'missing' | 'chain' | 'revoked'

/**
 * 来源类别。
 * inner 是内置的内部插件来源，awesome 是内置的组织社区来源，user 是用户自加来源。
 * inner 与 awesome 同属内置默认项：不可删除、不可编辑、不可移动，顺序也由内置表决定；
 * 只有 user 能增删改与调序。
 */
export type SourceKind = 'inner' | 'awesome' | 'user'

/** 用户可配置的来源；base_url 按顺序尝试 */
export type MarketSource = {
  id: string
  /** 显示名；用户来源可改，只影响界面与筛选，不参与信任与合集判定 */
  name: string
  /**
   * 合集标识名：信任清单查找与合集 id 归一化只认它，创建来源时按当时的名称固定。
   * 改名不动这个字段，因此改名前后的信任结论与证书取件路径完全一致。
   * 旧持久化数据缺该字段时取 name，与引入它之前的口径相同。
   */
  collectionName: string
  baseUrls: string[]
  /**
   * 内置项：恒等于 kind !== 'user'。
   * 只为兼容旧持久化数据保留，判定统一走 isBuiltinSource。
   */
  builtin: boolean
  /**
   * 来源类别；旧持久化数据缺该字段时按 id 与 builtin 标记兜底推断。
   * 内置项是市场默认项：删除、改地址、改名与移动一律返回失败，不静默忽略。
   */
  kind: SourceKind
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
  /**
   * 由 meta.json 推导的清单：capabilities 与 mounts 都取自 meta.json。
   * 缺 capabilities 时为 null，安装时整份交给产物自带的 manifest；
   * 缺 mounts 时清单不带该字段，由引擎在安装阶段用产物导出的 manifest 补齐。
   */
  manifest: PluginManifest | null
  /** 该插件的 versions.json 与展示版本 meta.json 是否都通过 L3 清单校验 */
  catalogVerified: boolean
  /** 安装时原样交给引擎的目录结论 */
  conclusions: CatalogConclusions
  /** 拉取失败或结构不符时的文案键 */
  error: TranslationKey | null
}

/**
 * 目录数据校验结论。
 * 来自三层哈希清单：L1 覆盖合集根目录数据，L2 覆盖作者目录，L3 覆盖插件版本目录。
 * 清单缺失或验签失败时不阻断，一律按未校验处理，产物仍由 plugin.js.sig 独立验证。
 */
export type CatalogConclusions = {
  /** 合集根 L1 清单验签通过，且本次消费的目录文件哈希一致 */
  catalogVerified: boolean
  /** 该版本的 L3 清单验签通过，且 versions.json 与该版本 meta.json 哈希一致 */
  metaVerified: boolean
  /** 各层清单 revision；缺哪层表示该层没有拿到可用清单 */
  revisions: ManifestRevisions
  /** L2 清单登记的 author_pub.pem 哈希；没拿到 L2 清单时缺省，引擎按未校验处理 */
  authorPubSha512?: string
}

/** 清单 revision 回退的提示；只警告，不阻断 */
export type RevisionWarning = {
  /** 出问题的层：L1 合集根、L2 作者目录、L3 插件目录 */
  layer: 'L1' | 'L2' | 'L3'
  /** 该层相对来源根目录的路径；L1 为空串 */
  path: string
  /** 本地记录的 revision */
  seen: number
  /** 本次拿到的 revision */
  revision: number
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
  /** 该来源在信任清单登记的合集 EEC 证书 PEM；未列入清单时为 null */
  eec: string | null
  /** 证书来自 trusted-manifest 信任清单，而不是来源站点自己分发的合集证书 */
  eecFromTrustList: boolean
  /** 合集 EEC 证书链是否校验通过；endorsed 来源为 false 时表示只有 dsc 背书这一层判定 */
  chainVerified: boolean
  /** 合集 id：清单登记的 id 优先，其次清单登记的目录名，最后用站点名归一化 */
  collectionId: string
  /**
   * 来源模型：collection 是三层清单的合集，site 是整站签名站点，
   * unknown 表示两种模型的特征文件都不成立，目录照常展示但结论一律为未校验。
   */
  model: SourceModel
  plugins: CatalogPlugin[]
  fetchedAt: number | null
  /** 合集根目录数据是否已按 L1 清单校验通过 */
  catalogVerified: boolean
  /** 各层清单 revision 回退的提示；只警告，不阻断 */
  revisionWarnings: RevisionWarning[]
  /** 结构不符被跳过的插件数 */
  skipped: number
  error: TranslationKey | null
}

/**
 * 安装计划；交给引擎的 installFromUrl。
 * eec 是信任清单登记的合集证书，登记了就用它，省一次请求；
 * eecUrls 是来源自带的证书地址，按顺序尝试：公开发布布局 certs/<合集 id>/<合集 id>-eec.crt 优先，
 * 旧站点的扁平布局 certs/<合集 id>-eec.crt 兼容，最旧的 eec.pem 最后兜底。
 * 两种证书都必须由引擎用内置根 CA 通过证书链校验才会用于验签，链不通过时来源结论为 failed。
 */
export type InstallPlan = CatalogConclusions & {
  /** plugin.js 地址 */
  url: string
  /** 该版本目录的地址,安装时入库,后续直接按它请求 versions.json、meta.json */
  dataBase: string
  /** 插件目录的地址,安装时入库,用于取 versions.json */
  pluginBase: string
  manifest?: PluginManifest
  sourceType: PluginSourceType
  /** 合集 EEC 证书 PEM；来自 trusted-manifest 信任清单，已登记时优先使用 */
  eec?: string
  /** 来源自带的合集证书地址，按顺序尝试（嵌套、扁平、eec.pem 三档）；清单未登记时由引擎依次取用 */
  eecUrls?: string[]
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
