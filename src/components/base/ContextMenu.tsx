import clsx from 'clsx'
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDismiss, VIEWPORT_PADDING } from './anchored.js'
import styles from './Menu.module.css'

/**
 * 跟随光标的右键菜单浮层。
 * 宿主没有全局右键菜单机制, 这里给「会话行」与「消息」两类目标面提供同一份浮层:
 * 位置按光标坐标, 超出视口时向视口内收口; 点外部或按 Esc 关闭; 不做模态遮罩。
 * 宿主项由调用方给, 插件项经 menu.item 槽位追加(见 plugins/pluginContextMenu.ts)。
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

/** 右键事件到打开状态; 阻止浏览器原生菜单与文本选择 */
export const useContextMenu = () => {
  const [point, setPoint] = useState<ContextMenuPoint | null>(null)
  const open = useCallback((event: { preventDefault: () => void; clientX: number; clientY: number }) => {
    event.preventDefault()
    setPoint({ x: event.clientX, y: event.clientY })
  }, [])
  const close = useCallback(() => setPoint(null), [])
  return { point, open, close }
}

export const ContextMenu = ({
  point,
  items,
  onClose,
}: {
  point: ContextMenuPoint
  items: readonly ContextMenuItem[]
  onClose: () => void
}) => {
  const floatingRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: point.y,
    left: point.x,
  })
  useDismiss(true, [floatingRef], onClose)

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
    >
      {items.map((item) => (
        <div
          key={item.key}
          role="menuitem"
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
