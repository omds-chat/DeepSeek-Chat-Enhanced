import { create } from 'zustand'
import type { SlotName } from '../dsc-plugin-engine/index.js'

/**
 * 主区面板的单一命名空间, 与 dsh 的 MainPanelId | null 同构:
 * null 表示会话(含会话视图标签栏), 'plugins' 是插件管理面板,
 * 其余是插件槽位页 { slot, pluginId, id }。
 * 面板选中与会话选中是两套独立状态: 切面板不改会话, 标签切换不丢失会话上下文;
 * 选中会话一律回到 null, 落点在 services/chat/store.ts 的 selectSession 与 newChat。
 */
export type SlotPageRef = {
  readonly slot: SlotName
  readonly pluginId: string
  readonly id: string
}

export type PanelId = 'plugins' | SlotPageRef

export type PluginViewState = {
  activePanelId: PanelId | null
}

export const usePluginView = create<PluginViewState>(() => ({
  activePanelId: null,
}))

const sameSlotPage = (a: SlotPageRef, b: SlotPageRef): boolean =>
  a.slot === b.slot && a.pluginId === b.pluginId && a.id === b.id

/** 当前面板是否等于给定面板; 槽位页按三个字段比较, 字符串与 null 直接相等比较 */
export const isPanelActive = (active: PanelId | null, id: PanelId | null): boolean => {
  if (active === null || id === null) {
    return active === id
  }
  if (typeof active === 'string' || typeof id === 'string') {
    return active === id
  }
  return sameSlotPage(active, id)
}

/** 把面板 id 收窄成槽位页; 不在槽位页上(会话或插件面板)时为 null */
export const asSlotPage = (id: PanelId | null): SlotPageRef | null =>
  id !== null && typeof id !== 'string' ? id : null

/**
 * 切到某个面板; 已经在该面板上时什么都不做, 免得订阅者空转重渲染。
 * 未登记的面板由调用方保证(导航行与标签栏都从登记表派生), 这里不再校验。
 */
export const selectPanel = (id: PanelId | null): void => {
  if (isPanelActive(usePluginView.getState().activePanelId, id)) {
    return
  }
  usePluginView.setState({ activePanelId: id })
}

/** 选中一个槽位页面 */
export const openSlotPage = (page: SlotPageRef): void => {
  selectPanel(page)
}

/**
 * 回到会话(null); selectPanel(null) 的薄封装, 保留名字减少调用点改动。
 * 调用点: services/chat/store.ts 的 newChat 与 selectSession, 以及页面返回面包屑。
 */
export const returnToChat = (): void => {
  selectPanel(null)
}

/**
 * 停留的槽位页是否已不在登记表里。
 * 插件停用或卸载会撤销登记, 界面据此退回会话视图; 不在此判断插件状态,
 * 只看登记表: 页面还在就还能看, 撤销了就不该再停留。
 */
export const revokedSlotPage = (
  active: PanelId | null,
  pages: readonly SlotPageRef[]
): SlotPageRef | null => {
  const page = asSlotPage(active)
  if (!page) {
    return null
  }
  const alive = pages.some((item) => sameSlotPage(item, page))
  return alive ? null : page
}

/**
 * 撤销守卫: 停留的槽位页被撤销时退回会话视图, 并交给调用方提示一次。
 * notify 由宿主注入(界面层发气泡), 本模块不碰界面与通知;
 * 返回被撤销的页面键, 没有发生回退时为 null。
 */
export const settleRevokedPage = (
  pages: readonly SlotPageRef[],
  notify: (page: SlotPageRef) => void
): SlotPageRef | null => {
  const revoked = revokedSlotPage(usePluginView.getState().activePanelId, pages)
  if (!revoked) {
    return null
  }
  returnToChat()
  notify(revoked)
  return revoked
}
