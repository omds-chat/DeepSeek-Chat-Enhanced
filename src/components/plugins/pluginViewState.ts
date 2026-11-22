import { create } from 'zustand'
import { setPluginPanelTab, type PluginPanelTab } from './pluginPanelState.js'

/**
 * 会话视图的选中项。
 * 插件页面不是插件面板里的一个标签页, 而是与既有会话视图并列的一种视图:
 * 用户在会话视图列表里选中它, 主区就整块渲染该页面;
 * 插件不登记页面时列表里没有任何入口, 会话视图保持既有行为。
 */
export type PluginView =
  | { readonly kind: 'chat' }
  /** 插件面板: 插件管理界面, 与会话视图同样互斥 */
  | { readonly kind: 'panel' }
  /** 某个插件的某个页面 */
  | { readonly kind: 'page'; readonly pluginId: string; readonly pageId: string }

/** 页面入口的键; 页面 id 与插件 id 共同定位一个入口 */
export type PluginPageRef = { readonly pluginId: string; readonly pageId: string }

export type PluginViewState = {
  view: PluginView
  /**
   * 进入插件视图前选中的会话; 返回会话视图时用它恢复上下文。
   * 插件视图不改变会话的选中项, 记下来是为了返回时不丢掉「刚才看的是哪个会话」。
   */
  originSessionId: string | null
}

/** 会话视图的选中项; 常量让「已经在会话视图」时不必产生新的状态对象 */
const CHAT_VIEW: PluginView = { kind: 'chat' }

export const usePluginView = create<PluginViewState>(() => ({
  view: CHAT_VIEW,
  originSessionId: null,
}))

/**
 * 回到会话视图; 来源会话一并清掉, 下次进入时重新记。
 * 已经在会话视图时什么都不做: 选中会话是高频操作, 不必让订阅者重渲染。
 */
export const returnToChat = (): void => {
  const state = usePluginView.getState()
  if (state.view === CHAT_VIEW && state.originSessionId === null) {
    return
  }
  usePluginView.setState({ view: CHAT_VIEW, originSessionId: null })
}

/** 切到插件面板; tab 为进入时选中的标签页, 来源会话随之记下 */
export const openPluginPanel = (
  tab: PluginPanelTab = 'installed',
  originSessionId: string | null = null
): void => {
  setPluginPanelTab(tab)
  usePluginView.setState({ view: { kind: 'panel' }, originSessionId })
}

/** 选中一个插件视图; 记住来源会话, 返回时用它恢复上下文 */
export const openPluginPage = (
  pluginId: string,
  pageId: string,
  originSessionId: string | null = null
): void => {
  usePluginView.setState({ view: { kind: 'page', pluginId, pageId }, originSessionId })
}

/** 当前视图停留的页面; 不在页面上时为 null */
export const viewedPage = (view: PluginView): PluginPageRef | null =>
  view.kind === 'page' ? { pluginId: view.pluginId, pageId: view.pageId } : null

/**
 * 停留的页面是否已不在登记表里。
 * 插件停用或卸载会撤销登记, 界面据此退回会话视图; 不在此判断插件状态,
 * 只看登记表: 页面还在就还能看, 撤销了就不该再停留。
 */
export const revokedPage = (
  view: PluginView,
  entries: readonly PluginPageRef[]
): PluginPageRef | null => {
  const page = viewedPage(view)
  if (!page) {
    return null
  }
  const alive = entries.some(
    (entry) => entry.pluginId === page.pluginId && entry.pageId === page.pageId
  )
  return alive ? null : page
}

/**
 * 撤销守卫: 停留的页面被撤销时退回会话视图, 并交给调用方提示一次。
 * notify 由宿主注入(界面层发气泡), 本模块不碰界面与通知;
 * 返回被撤销的页面键, 没有发生回退时为 null。
 */
export const settleRevokedPage = (
  entries: readonly PluginPageRef[],
  notify: (page: PluginPageRef) => void
): PluginPageRef | null => {
  const revoked = revokedPage(usePluginView.getState().view, entries)
  if (!revoked) {
    return null
  }
  returnToChat()
  notify(revoked)
  return revoked
}
