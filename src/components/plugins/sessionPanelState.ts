import { create } from 'zustand'

/**
 * 会话右栏面板自身的状态: 开合与当前标签。
 * 与主区面板(pluginViewState 的 activePanelId)是两套状态: 右栏换标签不改主区、不改会话上下文,
 * 主区回到会话也不影响右栏停在哪个标签。
 * 段落页有固定的标签键, 其余标签键取「插件 id + 槽位 id」, 与登记表的唯一性口径一致。
 */
export const SESSION_PANEL_SECTIONS_TAB = 'sections'

export type SessionPanelState = {
  /** 右栏是否收起; 收起时请求只在会话页头留一个开启按钮 */
  collapsed: boolean
  /** 当前标签键; null 表示还没选过, 由渲染方落到第一个可用标签 */
  activeTab: string | null
}

export const useSessionPanel = create<SessionPanelState>(() => ({
  collapsed: false,
  activeTab: null,
}))

/** 收起或展开右栏; 状态没变时不写 store, 免得订阅者空转 */
export const setSessionPanelCollapsed = (collapsed: boolean): void => {
  if (useSessionPanel.getState().collapsed === collapsed) {
    return
  }
  useSessionPanel.setState({ collapsed })
}

/** 切到某个标签; 相同标签不重复写入 */
export const selectSessionPanelTab = (activeTab: string | null): void => {
  if (useSessionPanel.getState().activeTab === activeTab) {
    return
  }
  useSessionPanel.setState({ activeTab })
}

/** 右栏条目的标签键: 段落页用固定键, 其余用插件 id 与槽位 id */
export const slotTabKey = (pluginId: string, id: string): string => pluginId + '/' + id
