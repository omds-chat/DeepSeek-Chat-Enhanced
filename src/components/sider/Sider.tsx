import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconPanelLeftOutline16,
  IconPluginOutline16,
  IconSettingsOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import {
  openPluginPage,
  openPluginPanel,
  returnToChat,
  usePluginView,
} from '../plugins/pluginViewState.js'
import { usePluginPageViews } from '../plugins/usePluginPageViews.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/**
 * 展开的侧边栏：名称与收起按钮、开启新对话、插件视图分组与按时间分组的会话列表、底部设置。
 * 插件视图分组只在有插件登记页面时出现，条目与会话条目同形，选中即由主区渲染该页面；
 * 移动端放在抽屉里，收起按钮关闭抽屉。
 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const view = usePluginView((state) => state.view)
  const pageViews = usePluginPageViews()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.appName}>
          <span className={styles.appNameLine}>{t('appNameLine1')}</span>
          <span className={styles.appNameBadge}>{t('appNameBadge')}</span>
        </div>
        <IconButton
          className={styles.topAction}
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          // 新对话本身就会回到会话视图(见 services/chat/store.ts 的 newChat)
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {/* 插件视图分组: 没有插件登记页面时整块不出现, 会话列表保持原样 */}
          {pageViews.length > 0 ? (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>{t('pluginViewsGroup')}</div>
              {pageViews.map((item) => {
                const selected =
                  view.kind === 'page' &&
                  view.pluginId === item.pluginId &&
                  view.pageId === item.pageId
                return (
                  <button
                    key={item.pluginId + '/' + item.pageId}
                    type="button"
                    className={clsx(styles.viewItem, selected && styles.viewItemActive)}
                    aria-current={selected ? 'page' : undefined}
                    onClick={() => {
                      openPluginPage(item.pluginId, item.pageId, activeId)
                      // 移动端抽屉里选中视图后收起抽屉, 直接看到主区域
                      closeMobileSider()
                    }}
                  >
                    <span className={styles.viewTitle}>{item.title}</span>
                    <span className={styles.viewCaption}>{item.pluginName}</span>
                  </button>
                )
              })}
            </div>
          ) : null}
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  onDelete={() => setDeleting(session)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.bottom}>
        <button
          type="button"
          className={clsx(styles.settings, view.kind === 'panel' && styles.settingsActive)}
          aria-pressed={view.kind === 'panel'}
          onClick={() => {
            if (view.kind === 'panel') {
              returnToChat()
            } else {
              openPluginPanel('installed', activeId)
            }
            // 移动端抽屉里点入口后收起抽屉，直接看到主区域
            closeMobileSider()
          }}
        >
          <span className={styles.settingsIcon}>
            <IconPluginOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('pluginPanelTitle')}</span>
        </button>
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  if (!open) {
    return null
  }
  return (
    <>
      <div className={styles.drawerMask} onClick={closeMobileSider} />
      <div className={styles.drawer}>
        <Sider mobile />
      </div>
    </>
  )
}
