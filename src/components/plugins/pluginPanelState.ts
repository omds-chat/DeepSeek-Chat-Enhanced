import { create } from 'zustand'

/** 插件面板的标签页：已安装 / 插件市场 */
export type PluginPanelTab = 'installed' | 'market'

/** 插件面板的开合状态与当前标签页 */
export const usePluginPanel = create(() => ({
  open: false,
  tab: 'installed' as PluginPanelTab,
}))

/** 打开面板；tab 为打开时选中的标签页 */
export const openPluginPanel = (tab: PluginPanelTab = 'installed') =>
  usePluginPanel.setState({ open: true, tab })

export const closePluginPanel = () => usePluginPanel.setState({ open: false })
