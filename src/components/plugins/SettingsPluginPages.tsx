import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { useSlotRegistry } from './useSlotRegistry.js'
import { settingsPages } from './slotProjection.js'
import { PluginPageBlocks, useSlotPageModel } from './PluginPageBlocks.js'
import type { SlotPageRef } from './pluginViewState.js'
import styles from './PluginSlots.module.css'

/**
 * 系统设置里的「插件」分组。
 * 列出全部 settings.page 登记项(插件名 + 页面标题), 点击后在同一分组内渲染该页面;
 * 页面内容复用插件页的区块渲染器(PluginPageBlocks.tsx), 与 nav.panel、conversation.tabs 同一份实现,
 * 因此表单控件、动作按钮与刷新语义完全一致。没有登记项时整块不渲染(分组本身也不出现)。
 */

/** 一个登记项在设置里的页面引用; 槽位名固定为 settings.page */
const pageRef = (pluginId: string, id: string): SlotPageRef => ({
  slot: 'settings.page',
  pluginId,
  id,
})

/** 详情: 返回列表 + 页面区块; 顶部用悬浮卡片式的面包屑, 不做模态遮罩 */
const SettingsPluginPage = ({
  page,
  onBack,
}: {
  page: { pluginId: string; id: string; title: string; pluginName: string }
  onBack: () => void
}) => {
  const t = useTranslate()
  const { state, model, snapshot, formModel, runAction } = useSlotPageModel(pageRef(page.pluginId, page.id))
  return (
    <>
      <div className={styles.settingsPageHead}>
        <Button variant="outlined" size="s" onClick={onBack}>
          {t('settingsPluginPageBack')}
        </Button>
        <span className={styles.settingsPageHeadTitle}>{page.title}</span>
      </div>
      {state.kind === 'loading' ? (
        <div className={styles.settingsPageEmpty}>{t('pluginPagesLoading')}</div>
      ) : state.kind === 'missing' || !model ? (
        <div className={styles.settingsPageEmpty}>{t('pluginPagesLoadFailed')}</div>
      ) : (
        <PluginPageBlocks
          model={model}
          snapshot={snapshot}
          formModel={formModel}
          runAction={runAction}
        />
      )}
    </>
  )
}

/** 插件分组主体: 列表与详情二选一 */
export const SettingsPluginPages = () => {
  const t = useTranslate()
  const { entries, plugins } = useSlotRegistry()
  const pages = settingsPages(entries, plugins, t)
  const [selected, setSelected] = useState<string | null>(null)
  if (pages.length === 0) {
    return null
  }
  const current = pages.find((page) => page.key === selected)
  if (current) {
    return <SettingsPluginPage page={current} onBack={() => setSelected(null)} />
  }
  return (
    <div className={styles.settingsPageList} role="list">
      {pages.map((page) => (
        <button
          key={page.key}
          type="button"
          role="listitem"
          className={styles.settingsPageRow}
          onClick={() => setSelected(page.key)}
        >
          <span className={styles.settingsPageTitle}>{page.title}</span>
          <span className={styles.settingsPagePlugin}>{page.pluginName}</span>
        </button>
      ))}
    </div>
  )
}
