import { isPageSlot, type PluginStateView, type SlotEntry, type SlotName } from '../dsc-plugin-engine/index.js'
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
 * 由登记表派生面板条目。
 * 只收页面型槽位(nav.panel、conversation.tabs、settings.page): 其余槽位是工具条按钮、通知条、
 * 消息动作与菜单项, 不是面板入口, 不能出现在侧边栏导航行与会话标签栏里。
 * 登记表已按槽位内排序(order 升序、同值按登记顺序), 这里只做标题文案解析、
 * 插件名补全与图标键透传, 不再排序。
 * 纯函数, 不读引擎也不订阅: 与界面无关, 夹具可以直接喂登记表进来。
 */
export const slotPanelItems = (
  entries: readonly SlotEntry[],
  plugins: readonly PluginStateView[],
  t: Translate
): SlotPanelItem[] => {
  const names = new Map(plugins.map((plugin) => [plugin.id, plugin.name]))
  return entries.filter((entry) => isPageSlot(entry.slot)).map((entry) => ({
    pluginId: entry.pluginId,
    slot: entry.slot,
    id: entry.id,
    title: titledText(entry, entry.id, t),
    pluginName: names.get(entry.pluginId) ?? entry.pluginId,
    ...(entry.iconKey === undefined ? {} : { iconKey: entry.iconKey }),
  }))
}
