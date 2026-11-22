import type { ContextMenuItem } from '../base/ContextMenu.js'
import type { MenuTarget } from '../dsc-plugin-engine/index.js'
import { SlotIcon } from './slotIcons.js'
import { useTranslate } from '../../i18n/index.js'
import { menuRows } from './slotProjection.js'
import { dispatchActionRow } from './slotActions.js'
import { useSlotRegistry } from './useSlotRegistry.js'

/**
 * 右键菜单里的插件项。
 * menu.item 登记项按 target 分流: 会话行右键只取 target='session', 消息右键只取 target='message';
 * 点击经 ui:slot-action 分发, 载荷的 itemKey 带该次右键针对的会话 id 或消息 id。
 * 图标统一用宿主的通用插件图标, 描述里不接受图标键(菜单项只是行, 不需要逐项配图)。
 */
export const usePluginMenuItems = (target: MenuTarget, subjectId: string): ContextMenuItem[] => {
  const t = useTranslate()
  const { entries } = useSlotRegistry()
  return menuRows(entries, target, t).map((row) => ({
    key: 'plugin:' + row.key,
    label: row.label,
    icon: <SlotIcon />,
    onSelect: () => dispatchActionRow(row, 'menu.item', subjectId),
  }))
}
