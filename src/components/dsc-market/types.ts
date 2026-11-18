import type { TranslationKey } from '../../i18n/index.js'
import type { PluginManifest, PluginSourceType } from '../dsc-plugin-engine/types.js'

/** 来源信任状态；unverified 表示当前构建没有可用的 dsc 公钥 */
export type SourceTrust = 'trusted' | 'untrusted' | 'unverified'

/** 信任失败原因；界面据此给出文案 */
export type TrustFailure = 'missing' | 'signature'

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
  /** 最新版本 plugin.js 的签名 */
  sign: string | null
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
  /** 该来源的 plugin_secret.pub 文本 */
  pub: string | null
  plugins: CatalogPlugin[]
  fetchedAt: number | null
  /** 结构不符被跳过的插件数 */
  skipped: number
  error: TranslationKey | null
}

/** 安装计划；交给引擎的 installFromUrl */
export type InstallPlan = {
  url: string
  manifest?: PluginManifest
  sourceType: PluginSourceType
  pub: string
  sign: string
}
