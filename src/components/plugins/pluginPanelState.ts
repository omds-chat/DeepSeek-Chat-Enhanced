import { create } from 'zustand'

/** 插件页的标签页：已安装 / 插件市场 */
export type PluginPanelTab = 'installed' | 'market'

/** 主区域的当前视图：对话 / 插件 */
export type PluginView = 'chat' | 'plugins'

/** 主区域视图、插件页的当前标签页与详情页；detailPluginId 非 null 时覆盖标签页内容 */
export const usePluginPanel = create(() => ({
  view: 'chat' as PluginView,
  tab: 'installed' as PluginPanelTab,
  /** 详情页展示的插件 id；null 表示列表视图，不做路由，返回即回列表 */
  detailPluginId: null as string | null,
}))

/** 切到插件视图；tab 为进入时选中的标签页，详情视图一并复位 */
export const openPluginPanel = (tab: PluginPanelTab = 'installed') =>
  usePluginPanel.setState({ view: 'plugins', tab, detailPluginId: null })

/** 回到对话视图 */
export const showChat = () => usePluginPanel.setState({ view: 'chat' })

/** 进入单个插件的详情页（设置表面） */
export const openPluginDetail = (pluginId: string) =>
  usePluginPanel.setState({ detailPluginId: pluginId })

/** 从详情页返回列表 */
export const closePluginDetail = () => usePluginPanel.setState({ detailPluginId: null })
