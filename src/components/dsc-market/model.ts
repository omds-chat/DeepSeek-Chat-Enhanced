import { layerUrlOf, type ManifestReader } from '../../services/integrity/manifest.js'
import { fetchSiteManifest, type SiteManifestFetch } from '../../services/integrity/site.js'

/**
 * 来源模型识别。
 * 合集模型的特征文件是根目录的 manifest.json 与 plugins.json（三层哈希清单）；
 * 整站模型的特征文件是 web_files.json 与随站点分发的证书（逐文件 CMS 签名）。
 * 识别顺序固定：先探测合集，取不到再探测整站；两种都不成立时按未确认处理，不报错。
 * 这里只判定模型，不判定任何签名结论，也不影响目录数据的取件方式。
 */

/** 来源模型；unknown 表示两种模型的特征文件都不成立 */
export type SourceModel = 'collection' | 'site' | 'unknown'

/** 模型识别的取件结果 */
export type SourceProbe = {
  model: SourceModel
  /** plugins.json 的原始字节；目录索引两种模型通用，探测时一并取回，避免重复请求 */
  plugins: Uint8Array<ArrayBuffer> | null
  /** 整站清单与清单签名；只有整站模型才带 */
  site: SiteManifestFetch | null
}

/** 合集模型的特征文件 */
const COLLECTION_FILES: readonly string[] = ['manifest.json', 'plugins.json']

/**
 * 识别来源模型。
 * 合集优先：manifest.json 与 plugins.json 都取到即按合集处理，不看整站特征文件。
 * 整站其次：web_files.json 取到且站点证书取到时按整站处理。
 * 其余情形按未确认处理，返回的 plugins 仍交给调用方解析目录，目录照常展示、结论按未校验。
 */
export const detectSourceModel = async (
  baseUrl: string,
  read: ManifestReader,
  certPem: string
): Promise<SourceProbe> => {
  const [rootManifest, plugins] = await Promise.all([
    read(layerUrlOf(baseUrl, '') + COLLECTION_FILES[0]),
    read(layerUrlOf(baseUrl, '') + COLLECTION_FILES[1]),
  ])
  if (rootManifest !== null && plugins !== null) {
    return { model: 'collection', plugins, site: null }
  }
  // 整站模型要求证书也在位：证书是识别特征之一，取不到时整站路径无法验签
  if (certPem.trim() === '') {
    return { model: 'unknown', plugins, site: null }
  }
  const site = await fetchSiteManifest(baseUrl, read)
  if (site.manifest !== null) {
    return { model: 'site', plugins, site }
  }
  return { model: 'unknown', plugins, site: null }
}
