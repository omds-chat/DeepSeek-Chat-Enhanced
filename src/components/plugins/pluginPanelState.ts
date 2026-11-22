import { create } from 'zustand'

/**
 * 插件面板的标签页: 已安装 / 插件市场。
 * 插件槽位页面不是这里的标签页: 主区面板的选中项由 pluginViewState 的 activePanelId 维护,
 * 本模块只管插件面板自身的分页与详情。
 */
export type PluginPanelTab = 'installed' | 'market'

/** 插件面板的当前标签页与详情页; detailPluginId 非 null 时覆盖标签页内容 */
export const usePluginPanel = create(() => ({
  tab: 'installed' as PluginPanelTab,
  /** 详情页展示的插件 id; null 表示列表视图, 不做路由, 返回即回列表 */
  detailPluginId: null as string | null,
}))

/** 切到某个标签页, 详情视图一并复位 */
export const setPluginPanelTab = (tab: PluginPanelTab): void => {
  usePluginPanel.setState({ tab, detailPluginId: null })
}

/** 进入单个插件的详情页(设置表面) */
export const openPluginDetail = (pluginId: string) => {
  usePluginPanel.setState({ detailPluginId: pluginId })
}

/** 从详情页返回列表 */
export const closePluginDetail = () => usePluginPanel.setState({ detailPluginId: null })
