import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { IconButton } from '../base/IconButton.js'
import { SlotIcon } from '../plugins/slotIcons.js'
import {
  isPanelActive,
  selectPanel,
  usePluginView,
  type PanelId,
} from '../plugins/pluginViewState.js'
import { useSlotPanels } from '../plugins/useSlotPanels.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './Sider.module.css'

type PanelRow = {
  key: string
  id: PanelId
  title: string
  iconKey?: string
}

/**
 * 侧边栏的导航行区域, 对应 dsh 的 sidebar.panellist: 静态的插件面板行在前,
 * 其后是全部 nav.panel 登记项(图标 + 标题, order 升序、同值按登记顺序)。
 * 面板不是开关语义: 点击即切换到该面板, 再次点击当前面板行不切回会话(与 dsh 一致),
 * 会话靠选中会话或标签栏的「对话」项回到。
 * wide 为假时逐面板一个图标(收起态入口), 悬停提示面板标题。
 */
export const SlotPanelList = ({ wide }: { wide: boolean }) => {
  const t = useTranslate()
  const panels = useSlotPanels()
  const active = usePluginView((state) => state.activePanelId)
  const rows: PanelRow[] = [
    { key: 'plugins', id: 'plugins', title: t('pluginPanelTitle') },
    ...panels
      .filter((item) => item.slot === 'nav.panel')
      .map((item) => ({
        key: item.pluginId + '/' + item.id,
        id: { slot: item.slot, pluginId: item.pluginId, id: item.id },
        title: item.title,
        ...(item.iconKey === undefined ? {} : { iconKey: item.iconKey }),
      })),
  ]
  if (!wide) {
    return (
      <div className={styles.panelNavCollapsed}>
        {rows.map((row) => {
          const selected = isPanelActive(active, row.id)
          return (
            <IconButton
              key={row.key}
              size="m"
              tone="primary"
              icon={<SlotIcon iconKey={row.iconKey} />}
              tooltip={row.title}
              aria-current={selected ? 'page' : undefined}
              onClick={() => selectPanel(row.id)}
            />
          )
        })}
      </div>
    )
  }
  return (
    <nav className={styles.panelNav} aria-label={t('panelNavLabel')}>
      {rows.map((row) => {
        const selected = isPanelActive(active, row.id)
        return (
          <button
            key={row.key}
            type="button"
            className={clsx(styles.panelRow, selected && styles.panelRowActive)}
            aria-current={selected ? 'page' : undefined}
            onClick={() => {
              selectPanel(row.id)
              // 移动端抽屉里选中面板后收起抽屉, 直接看到主区域
              closeMobileSider()
            }}
          >
            <span className={styles.panelRowIcon}>
              <SlotIcon iconKey={row.iconKey} />
            </span>
            <span className={styles.panelRowTitle}>{row.title}</span>
          </button>
        )
      })}
    </nav>
  )
}
