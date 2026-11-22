import type { ReactNode } from 'react'
import {
  IconBrowseOutline16,
  IconDataOutline16,
  IconGlobeLanguageOutline14,
  IconPluginOutline16,
  IconSettingsOutline16,
} from '../base/icons.js'

/**
 * nav.panel 登记项的图标查表。
 * 插件描述里的 iconKey 是宿主图标表的键(不是文案键); 未登记或未命中时回落为通用插件图标,
 * 保证任何未知键都不会让导航行缺图标。
 */
const SLOT_ICONS: Record<string, ReactNode> = {
  browse: <IconBrowseOutline16 />,
  data: <IconDataOutline16 />,
  globe: <IconGlobeLanguageOutline14 />,
  plugin: <IconPluginOutline16 />,
  settings: <IconSettingsOutline16 />,
}

export const SlotIcon = ({ iconKey }: { iconKey?: string }) => {
  const icon = iconKey === undefined ? undefined : SLOT_ICONS[iconKey]
  return icon ?? <IconPluginOutline16 />
}
