import type { PluginPageEntry, PluginStateView } from '../dsc-plugin-engine/index.js'
import { titledText, type Translate } from './pluginPageText.js'

/** 会话视图列表里的一条插件视图: 条目名是页面标题, 副标题是插件名 */
export type PluginPageViewItem = {
  readonly pluginId: string
  readonly pageId: string
  readonly title: string
  readonly pluginName: string
}

/**
 * 由登记表派生会话视图列表。
 * 登记表为空时返回空数组, 调用方据此把「插件视图」分组整块隐去:
 * 没有插件登记页面就没有任何入口, 会话视图保持既有行为。
 * 纯函数, 不读引擎也不订阅: 与界面无关, 夹具可以直接喂登记表进来。
 */
export const pluginPageViews = (
  entries: readonly PluginPageEntry[],
  plugins: readonly PluginStateView[],
  t: Translate
): PluginPageViewItem[] => {
  const names = new Map(plugins.map((plugin) => [plugin.id, plugin.name]))
  return entries.map((entry) => ({
    pluginId: entry.pluginId,
    pageId: entry.pageId,
    title: titledText(entry, entry.pageId, t),
    pluginName: names.get(entry.pluginId) ?? entry.pluginId,
  }))
}
