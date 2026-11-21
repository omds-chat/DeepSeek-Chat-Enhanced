import type { TranslationKey, TranslationParams } from '../../i18n/index.js'

/** 首次使用来源时的提示出口；普通提示，不带错误图标 */
export type AssetNotice = (key: TranslationKey, params?: TranslationParams) => void

/**
 * 取来源地址的 origin，用作去重键。
 * 地址无法解析时返回 null：这类调用会被 `assets:read` 直接拒绝，不构成对某个站点的访问。
 */
export const assetOriginOf = (url: string): string | null => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * 首次使用某个来源地址时报告一次。
 * 去重键是「插件 + 来源」：同一插件重复读取同一站点只报一次，另一个插件读取同一站点仍各自报一次，
 * 用户据此知道哪个插件在访问哪个站点。这里只报告事实，不替用户判断该站点是否可信。
 */
export const createAssetAnnouncer = (notice: AssetNotice) => {
  const reported = new Set<string>()
  return (pluginId: string, url: string): void => {
    const origin = assetOriginOf(url)
    if (origin === null) {
      return
    }
    const key = pluginId + ' ' + origin
    if (reported.has(key)) {
      return
    }
    reported.add(key)
    notice('pluginAssetSourceFirstUse', { id: pluginId, origin })
  }
}
