import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { useIsMobile } from '../../app/viewport.js'
import { IconPanelLeftOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { PluginPageBlocks, useSlotPageModel } from './PluginPageBlocks.js'
import { titledText } from './pluginPageText.js'
import { sessionPanelSectionItems, sessionSideTabItems, type SlotPanelItem } from './pluginViews.js'
import { SlotIcon } from './slotIcons.js'
import { useSlotRegistry } from './useSlotRegistry.js'
import {
  SESSION_PANEL_SECTIONS_TAB,
  selectSessionPanelTab,
  setSessionPanelCollapsed,
  slotTabKey,
  useSessionPanel,
} from './sessionPanelState.js'
import styles from './SessionPanel.module.css'

/**
 * 会话右栏面板: session.panel.section 的段落与 nav.side 的标签页共用这一块。
 * 两者都是页面型槽位(带区块模型), 所以共用 PluginPageBlocks 的渲染与表单生命周期:
 * 段落页把全部登记项按 order 逐段排下来(一项一段, 宿主画标题), 标签页一项一个可切换标签。
 * 右栏没有登记时不渲染, 会话视图与既有版面完全一致; 开合与当前标签只活在本组件的状态里,
 * 与主区面板(activePanelId)和会话选中是两套独立状态。
 */

type SessionPanelTab = {
  readonly key: string
  readonly title: string
  readonly iconKey?: string
  /** null 是段落页; 其余是 nav.side 的一项 */
  readonly item: SlotPanelItem | null
}

/** 段落或标签页的内容: 每个登记项各持一份页面模型与表单草稿 */
const SlotPanelContent = ({
  item,
  withTitle,
}: {
  item: SlotPanelItem
  withTitle: boolean
}) => {
  const t = useTranslate()
  const { state, model, snapshot, formModel, runAction } = useSlotPageModel({
    slot: item.slot,
    pluginId: item.pluginId,
    id: item.id,
  })
  if (state.kind === 'loading') {
    return <div className={styles.note}>{t('pluginPagesLoading')}</div>
  }
  if (!model) {
    return <div className={styles.note}>{t('pluginPagesLoadFailed')}</div>
  }
  return (
    <section className={withTitle ? styles.section : undefined}>
      {withTitle ? (
        <h2 className={styles.sectionTitle}>{titledText(model, item.title, t)}</h2>
      ) : null}
      <PluginPageBlocks
        model={model}
        snapshot={snapshot}
        formModel={formModel}
        runAction={runAction}
      />
    </section>
  )
}

/** 右栏本体; 无登记项、移动端或收起时返回 null, 不占版面 */
export const SessionPanel = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const { entries, plugins } = useSlotRegistry()
  const collapsed = useSessionPanel((state) => state.collapsed)
  const activeTab = useSessionPanel((state) => state.activeTab)
  const sections = sessionPanelSectionItems(entries, plugins, t)
  const sideTabs = sessionSideTabItems(entries, plugins, t)
  // 窄屏没有右栏的位置: 不渲染也不占宽, 会话页保持既有版面
  if (isMobile || collapsed || (sections.length === 0 && sideTabs.length === 0)) {
    return null
  }
  const tabs: SessionPanelTab[] = [
    ...(sections.length === 0
      ? []
      : [{ key: SESSION_PANEL_SECTIONS_TAB, title: t('sessionPanelAsideLabel'), item: null }]),
    ...sideTabs.map((item) => ({
      key: slotTabKey(item.pluginId, item.id),
      title: item.title,
      ...(item.iconKey === undefined ? {} : { iconKey: item.iconKey }),
      item,
    })),
  ]
  // 选中的标签被撤销(插件停用或卸载)时落到第一个可用标签, 不留空白右栏
  const selected = tabs.find((tab) => tab.key === activeTab) ?? tabs[0]
  return (
    <aside className={styles.aside} aria-label={t('sessionPanelAsideLabel')}>
      <div className={styles.head}>
        {tabs.length > 1 ? (
          <div className={styles.tabs} role="tablist" aria-label={t('sessionPanelAsideLabel')}>
            {tabs.map((tab) => {
              const active = tab.key === selected.key
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={clsx(styles.tab, active && styles.tabActive)}
                  onClick={() => selectSessionPanelTab(tab.key)}
                >
                  {tab.iconKey === undefined ? null : (
                    <span className={styles.tabIcon}>
                      <SlotIcon iconKey={tab.iconKey} />
                    </span>
                  )}
                  <span className={styles.tabLabel}>{tab.title}</span>
                </button>
              )
            })}
          </div>
        ) : (
          <span className={styles.headTitle}>{selected.title}</span>
        )}
      </div>
      <div className={styles.body}>
        {selected.item === null ? (
          sections.map((item) => (
            <SlotPanelContent key={slotTabKey(item.pluginId, item.id)} item={item} withTitle />
          ))
        ) : (
          <SlotPanelContent key={selected.key} item={selected.item} withTitle={false} />
        )}
      </div>
    </aside>
  )
}

/**
 * 会话页头的右栏开关: 右栏没有任何登记项时不渲染, 页头与现在完全一致。
 * 图标是左栏面板图标水平镜像(填充条在右), 表达「右栏」而不新增图标资源;
 * 收起与展开是同一个按钮, 只用 aria-expanded 与提示文案区分。
 */
export const SessionPanelToggle = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const { entries, plugins } = useSlotRegistry()
  const collapsed = useSessionPanel((state) => state.collapsed)
  const hasContent =
    sessionPanelSectionItems(entries, plugins, t).length > 0 ||
    sessionSideTabItems(entries, plugins, t).length > 0
  if (isMobile || !hasContent) {
    return null
  }
  return (
    <IconButton
      size="xs"
      className={styles.toggle}
      icon={<IconPanelLeftOutline16 />}
      tooltip={collapsed ? t('sessionPanelShow') : t('sessionPanelHide')}
      aria-expanded={!collapsed}
      onClick={() => setSessionPanelCollapsed(!collapsed)}
    />
  )
}
