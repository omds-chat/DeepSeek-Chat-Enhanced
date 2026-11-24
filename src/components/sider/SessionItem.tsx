import clsx from 'clsx'
import { memo, useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconEditOutline16, IconEllipsisOutline16, IconTrashOutline16 } from '../base/icons.js'
import { renameSession, selectSession } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { ContextMenu, useContextMenu } from '../base/ContextMenu.js'
import { usePluginMenuItems } from '../plugins/pluginContextMenu.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  onDelete: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  // 菜单展开时焦点已进浮层, 行不再 focus-within, 操作按钮要靠它保持可见
  const [menuOpen, setMenuOpen] = useState(false)
  const displayTitle = session.title || t('untitledChat')
  const rowRef = useRef<HTMLDivElement>(null)
  // 只有键盘退出重命名(Enter/Esc)才把焦点还给行, 指针点走的失焦不抢回来
  const restoreFocusRef = useRef(false)
  // 右键菜单: 宿主项(重命名、删除)之后追加插件经 menu.item 登记的自定义项
  const contextMenu = useContextMenu()
  const pluginItems = usePluginMenuItems('session', session.id)

  useEffect(() => {
    if (editing || !restoreFocusRef.current) {
      return
    }
    restoreFocusRef.current = false
    rowRef.current?.focus()
  }, [editing])

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            restoreFocusRef.current = true
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            restoreFocusRef.current = true
            setEditing(false)
          }
        }}
      />
    )
  }

  // 键盘与指针共用同一处激活逻辑
  const activate = () => {
    // 选中会话即回到会话视图: selectSession 内部一并切回(见 services/chat/store.ts)
    selectSession(session.id)
    closeMobileSider()
  }

  return (
    <div
      ref={rowRef}
      className={clsx(styles.item, active && styles.active, menuOpen && styles.menuOpen)}
      /*
       * 行内含重命名输入框与操作按钮, 改成 button 会嵌套交互元素,
       * 所以保留 div, 用 role/tabIndex 与 keydown 补上键盘可达。
       */
      role="button"
      tabIndex={0}
      /*
       * 行名直接取标题: 否则行内的操作按钮会把「更多」并入行的可访问名(Hi 更多)。
       */
      aria-label={displayTitle}
      aria-current={active ? 'page' : undefined}
      onContextMenu={contextMenu.open}
      onClick={activate}
      onKeyDown={(event) => {
        // 只处理落在行自身上的按键, 子元素(操作按钮)的 Enter/Space 归它们自己
        if (event.target !== event.currentTarget) {
          return
        }
        if (event.key !== 'Enter' && event.key !== ' ') {
          return
        }
        if (event.key === ' ') {
          // Space 默认会滚动列表
          event.preventDefault()
        }
        activate()
      }}
    >
      <div className={styles.title}>{displayTitle}</div>
      <div className={styles.action} onClick={(event) => event.stopPropagation()}>
        <Menu
          options={[
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: <IconEditOutline16 />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <IconTrashOutline16 />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
          onOpenChange={setMenuOpen}
        >
          {({ toggle }) => (
            <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
          )}
        </Menu>
      </div>
      {contextMenu.point ? (
        <ContextMenu
          point={contextMenu.point}
          returnFocusTo={contextMenu.returnFocusTo}
          items={[
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: <IconEditOutline16 />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <IconTrashOutline16 />,
              danger: true,
              onSelect: onDelete,
            },
            ...pluginItems,
          ]}
          onClose={contextMenu.close}
        />
      ) : null}
    </div>
  )
})
