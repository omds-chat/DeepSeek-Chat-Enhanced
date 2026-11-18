import { create } from 'zustand'

/** 插件页的标签页：已安装 / 插件市场 */
export type PluginPanelTab = 'installed' | 'market'

/** 主区域的当前视图：对话 / 插件 */
export type PluginView = 'chat' | 'plugins'

/** 主区域视图与插件页的当前标签页 */
export const usePluginPanel = create(() => ({
  view: 'chat' as PluginView,
  tab: 'installed' as PluginPanelTab,
}))

/** 切到插件视图；tab 为进入时选中的标签页 */
export const openPluginPanel = (tab: PluginPanelTab = 'installed') =>
  usePluginPanel.setState({ view: 'plugins', tab })

/** 回到对话视图 */
export const showChat = () => usePluginPanel.setState({ view: 'chat' })
