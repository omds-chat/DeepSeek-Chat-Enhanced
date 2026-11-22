import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import {
  isPanelActive,
  selectPanel,
  usePluginView,
  type SlotPageRef,
} from './pluginViewState.js'
import { useSlotPanels } from './useSlotPanels.js'
import styles from './ConversationTabs.module.css'

/**
 * 会话视图标签栏: 默认项「对话」在前, 其余为 conversation.tabs 登记项(order 升序)。
 * 选中插件标签时主区整块渲染该槽位页面; 面板选中与会话选中是两套独立状态,
 * 标签切换不改会话上下文。没有插件登记时整块不渲染, 会话视图保持既有外观。
 */
export const ConversationTabs = () => {
  const t = useTranslate()
  const active = usePluginView((state) => state.activePanelId)
  const panels = useSlotPanels()
  const tabs = panels.filter((item) => item.slot === 'conversation.tabs')
  if (tabs.length === 0) {
    return null
  }
  return (
    <div className={styles.bar} role="tablist" aria-label={t('conversationTabsLabel')}>
      <button
        type="button"
        role="tab"
        aria-selected={active === null}
        className={clsx(styles.tab, active === null && styles.tabActive)}
        onClick={() => selectPanel(null)}
      >
        {t('conversationTabChat')}
      </button>
      {tabs.map((item) => {
        const page: SlotPageRef = { slot: item.slot, pluginId: item.pluginId, id: item.id }
        const selected = isPanelActive(active, page)
        return (
          <button
            key={item.pluginId + '/' + item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            className={clsx(styles.tab, selected && styles.tabActive)}
            onClick={() => selectPanel(page)}
          >
            {item.title}
          </button>
        )
      })}
    </div>
  )
}
