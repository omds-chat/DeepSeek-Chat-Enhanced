import clsx from 'clsx'
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDismiss, VIEWPORT_PADDING } from './anchored.js'
import { dismissFloating, MENU_ITEM_TAB_INDEX, useFloatingMenuKeys } from './menuFocus.js'
import styles from './Menu.module.css'

/**
 * 跟随光标的右键菜单浮层。
 * 宿主没有全局右键菜单机制, 这里给「会话行」与「消息」两类目标面提供同一份浮层:
 * 位置按光标坐标, 超出视口时向视口内收口; 点外部或按 Esc 关闭; 不做模态遮罩。
 * 宿主项由调用方给, 插件项经 menu.item 槽位追加(见 plugins/pluginContextMenu.ts)。
 * 键盘: 展开时聚焦首项, 方向键移动, Enter/Space 触发, Esc/Tab 关闭并交还焦点(见 menuFocus)。
 */
export type ContextMenuItem = {
  key: string
  label: string
  icon?: ReactNode
  danger?: boolean
  onSelect: () => void
}

/** 一次右键的打开状态: 光标坐标 */
export type ContextMenuPoint = { x: number; y: number }

/** 焦点归还目标: 被右键的元素自身可聚焦时用它, 否则退回打开前的焦点元素 */
const resolveReturnTarget = (currentTarget: EventTarget | null): HTMLElement | null => {
  if (currentTarget instanceof HTMLElement && currentTarget.tabIndex >= 0) {
    return currentTarget
  }
  const active = document.activeElement
  return active instanceof HTMLElement && active !== document.body ? active : null
}

/** 右键事件到打开状态; 阻止浏览器原生菜单与文本选择 */
export const useContextMenu = () => {
  const [state, setState] = useState<{
    point: ContextMenuPoint
    returnFocusTo: HTMLElement | null
  } | null>(null)
  const open = useCallback(
    (event: {
      preventDefault: () => void
      clientX: number
      clientY: number
      currentTarget?: EventTarget | null
    }) => {
      event.preventDefault()
      setState({
        point: { x: event.clientX, y: event.clientY },
        returnFocusTo: resolveReturnTarget(event.currentTarget ?? null),
      })
    },
    []
  )
  const close = useCallback(() => setState(null), [])
  return {
    point: state ? state.point : null,
    returnFocusTo: state ? state.returnFocusTo : null,
    open,
    close,
  }
}

export const ContextMenu = ({
  point,
  items,
  onClose,
  returnFocusTo,
}: {
  point: ContextMenuPoint
  items: readonly ContextMenuItem[]
  onClose: () => void
  /** 关闭后焦点归还的元素; 不给时只关闭、不改动焦点 */
  returnFocusTo?: HTMLElement | null
}) => {
  const floatingRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: point.y,
    left: point.x,
  })
  const getTrigger = () => returnFocusTo ?? null
  useDismiss(true, [floatingRef], () => {
    dismissFloating(floatingRef.current, onClose, getTrigger)
  })
  const onKeyDown = useFloatingMenuKeys({
    open: true,
    containerRef: floatingRef,
    onClose,
    getTrigger,
  })

  // 先按光标摆一次, 绘制前按实际尺寸收口, 避免贴边时溢出视口
  useLayoutEffect(() => {
    const element = floatingRef.current
    if (!element) {
      return
    }
    const { width, height } = element.getBoundingClientRect()
    setPosition({
      top: Math.max(VIEWPORT_PADDING, Math.min(point.y, window.innerHeight - height - VIEWPORT_PADDING)),
      left: Math.max(VIEWPORT_PADDING, Math.min(point.x, window.innerWidth - width - VIEWPORT_PADDING)),
    })
  }, [point.x, point.y, items.length])

  if (items.length === 0) {
    return null
  }
  return createPortal(
    <div
      ref={floatingRef}
      className={styles.menu}
      style={{ top: position.top, left: position.left }}
      role="menu"
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <div
          key={item.key}
          role="menuitem"
          tabIndex={MENU_ITEM_TAB_INDEX}
          className={clsx(styles.option, item.danger && styles.danger)}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.icon === undefined ? null : <span className={styles.icon}>{item.icon}</span>}
          {item.label}
        </div>
      ))}
    </div>,
    document.body
  )
}
