import {
  isPanelEntrySlot,
  SLOT_NAV_SIDE,
  SLOT_SESSION_PANEL_SECTION,
  type PluginStateView,
  type SlotEntry,
  type SlotName,
} from '../dsc-plugin-engine/index.js'
import { titledText, type Translate } from './pluginPageText.js'

/** 侧边栏导航行与会话标签栏共用的一条面板条目: 标题用页面标题, 插件名做副标题 */
export type SlotPanelItem = {
  readonly pluginId: string
  readonly slot: SlotName
  readonly id: string
  readonly title: string
  readonly pluginName: string
  readonly iconKey?: string
}

/**
 * 由登记表派生面板条目, 只收 keep 选中的槽位。
 * 其余槽位是工具条按钮、通知条、消息动作与菜单项, 不是面板入口;
 * 登记表已按槽位内排序(order 升序、同值按登记顺序), 这里只做标题文案解析、
 * 插件名补全与图标键透传, 不再排序。
 * 纯函数, 不读引擎也不订阅: 与界面无关, 夹具可以直接喂登记表进来。
 */
const panelItemsOf = (
  entries: readonly SlotEntry[],
  plugins: readonly PluginStateView[],
  t: Translate,
  keep: (slot: SlotName) => boolean
): SlotPanelItem[] => {
  const names = new Map(plugins.map((plugin) => [plugin.id, plugin.name]))
  return entries
    .filter((entry) => keep(entry.slot))
    .map((entry) => ({
      pluginId: entry.pluginId,
      slot: entry.slot,
      id: entry.id,
      title: titledText(entry, entry.id, t),
      pluginName: names.get(entry.pluginId) ?? entry.pluginId,
      ...(entry.iconKey === undefined ? {} : { iconKey: entry.iconKey }),
    }))
}

/**
 * 侧边栏导航行与会话视图标签栏的条目: 只取三个面板入口型槽位。
 * 同样带区块的 session.panel.section 与 nav.side 落在会话右栏, 不是这里。
 */
export const slotPanelItems = (
  entries: readonly SlotEntry[],
  plugins: readonly PluginStateView[],
  t: Translate
): SlotPanelItem[] => panelItemsOf(entries, plugins, t, isPanelEntrySlot)

/** 会话右栏的段落: 一项 = 带标题的一段, 宿主画出标题与区块 */
export const sessionPanelSectionItems = (
  entries: readonly SlotEntry[],
  plugins: readonly PluginStateView[],
  t: Translate
): SlotPanelItem[] =>
  panelItemsOf(entries, plugins, t, (slot) => slot === SLOT_SESSION_PANEL_SECTION)

/** 会话右栏的标签页: 一项 = 右栏标签栏里的一个可切换标签 */
export const sessionSideTabItems = (
  entries: readonly SlotEntry[],
  plugins: readonly PluginStateView[],
  t: Translate
): SlotPanelItem[] => panelItemsOf(entries, plugins, t, (slot) => slot === SLOT_NAV_SIDE)
