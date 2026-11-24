import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import { dismissFloating, MENU_ITEM_TAB_INDEX, useFloatingMenuKeys } from './menuFocus.js'
import styles from './Menu.module.css'

export type MenuOption = {
  key: string
  label: string
  icon: ReactNode
  danger?: boolean
  onSelect: () => void
}

/**
 * 点击触发，向下展开；点外部或 Esc 关闭。
 * 键盘: 展开时聚焦首项, 方向键移动, Enter/Space 触发, Esc/Tab 关闭并交还焦点(见 menuFocus)。
 */
export const Menu = ({
  options,
  children,
  onOpenChange,
}: {
  options: MenuOption[]
  children: (props: { open: boolean; toggle: () => void }) => ReactNode
  /** 展开状态变化; 触发按钮只在悬停或聚焦时显示的宿主靠它保持可见 */
  onOpenChange?: (open: boolean) => void
}) => {
  const [open, setOpen] = useState(false)
  // 左侧对齐并再左移 5px，让菜单文字与触发元素图标对齐
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    { align: 'start', alignOffset: -5, offset: 4 }
  )
  const applyOpen = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }
  const close = () => applyOpen(false)
  // 焦点归还目标取包裹层, 真正的触发按钮在它里面
  const getTrigger = () => anchorRef.current
  useDismiss(open, [anchorRef, floatingRef], () => {
    dismissFloating(floatingRef.current, close, getTrigger)
  })
  const onKeyDown = useFloatingMenuKeys({
    open,
    containerRef: floatingRef,
    onClose: close,
    getTrigger,
  })

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        {children({ open, toggle: () => applyOpen(!open) })}
      </span>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.menu}
              style={position ?? undefined}
              role="menu"
              onKeyDown={onKeyDown}
            >
              {options.map((option) => (
                <div
                  key={option.key}
                  role="menuitem"
                  tabIndex={MENU_ITEM_TAB_INDEX}
                  className={clsx(styles.option, option.danger && styles.danger)}
                  onClick={() => {
                    close()
                    option.onSelect()
                  }}
                >
                  <span className={styles.icon}>{option.icon}</span>
                  {option.label}
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
