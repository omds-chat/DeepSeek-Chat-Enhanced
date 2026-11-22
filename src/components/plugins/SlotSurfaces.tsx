import { useTranslate } from '../../i18n/index.js'
import type { NoticeLevel } from '../dsc-plugin-engine/index.js'
import { useSlotRegistry } from './useSlotRegistry.js'
import {
  composerNoticeRows,
  composerToolbarRows,
  overlayNoticeGroups,
} from './slotProjection.js'
import { dispatchActionRow, dispatchMessageAction } from './slotActions.js'
import styles from './PluginSlots.module.css'

/**
 * 输入区与全局面板的三个非页面型槽位渲染:
 * composer.notice 是输入框上方的通知条(颜色随 tone), composer.toolbar 是输入框下方工具条里的按钮,
 * overlay.notice 是右上角的通知栈(按插件分组, 同一插件的多条通知合成一张卡片)。
 * 三者都只读登记表并订阅它的变更, 没有登记时整块不渲染; 按钮点击经 ui:slot-action 回调插件。
 */

/** 通知强度到样式类; 三个槽位共用同一套颜色语义 */
const levelClass = (level: NoticeLevel): string =>
  level === 'warning' ? styles.warning : level === 'error' ? styles.error : styles.info

/** 输入框上方的通知条; 一条登记一项 */
export const ComposerNotices = () => {
  const t = useTranslate()
  const { entries } = useSlotRegistry()
  const rows = composerNoticeRows(entries, t)
  if (rows.length === 0) {
    return null
  }
  return (
    <div className={styles.noticeStack} role="status" aria-live="polite">
      {rows.map((row) => (
        <div key={row.key} className={styles.notice + ' ' + levelClass(row.level)}>
          {row.text}
        </div>
      ))}
    </div>
  )
}

/** 输入框下方工具条里的插件按钮; 与宿主的开关同排 */
export const ComposerToolbar = () => {
  const t = useTranslate()
  const { entries } = useSlotRegistry()
  const rows = composerToolbarRows(entries, t)
  if (rows.length === 0) {
    return null
  }
  return (
    <div className={styles.toolbarGroup} role="group" aria-label={t('composerPluginToolbarLabel')}>
      {rows.map((row) => (
        <button
          key={row.key}
          type="button"
          className={styles.toolbarButton}
          title={row.label}
          onClick={() => dispatchActionRow(row, 'composer.toolbar')}
        >
          <span className={styles.toolbarLabel}>{row.label}</span>
        </button>
      ))}
    </div>
  )
}

/** 全局面板通知栈; 按插件分组, 每组一张悬浮卡片 */
export const PluginNoticeStack = () => {
  const t = useTranslate()
  const { entries, plugins } = useSlotRegistry()
  const groups = overlayNoticeGroups(entries, plugins, t)
  if (groups.length === 0) {
    return null
  }
  return (
    <div className={styles.overlayStack} role="status" aria-live="polite">
      {groups.map((group) => (
        <div key={group.pluginId} className={styles.overlayCard}>
          <div className={styles.overlayGroupHead}>
            {t('overlayPluginNoticesLabel') + ' · ' + group.pluginName}
          </div>
          {group.items.map((row) => (
            <div key={row.key} className={styles.overlayRow}>
              <span
                className={
                  styles.overlayDot +
                  (row.level === 'warning'
                    ? ' ' + styles.overlayDotWarning
                    : row.level === 'error'
                      ? ' ' + styles.overlayDotError
                      : '')
                }
              />
              <span>{row.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** 消息底部的插件操作行; 每条消息都渲染同一组按钮, itemKey 带消息 id */
export const MessageActionRowButtons = ({
  messageId,
  rows,
}: {
  messageId: string
  rows: readonly { key: string; pluginId: string; id: string; actionId: string; label: string }[]
}) => (
  <>
    {rows.map((row) => (
      <button
        key={row.key}
        type="button"
        className={styles.messageActionButton}
        onClick={() => dispatchMessageAction(row, messageId)}
      >
        {row.label}
      </button>
    ))}
  </>
)
