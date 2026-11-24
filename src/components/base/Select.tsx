import clsx from 'clsx'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import { IconCheckOutline16, IconChevronDownOutline14 } from './icons.js'
import { dismissFloating, MENU_ITEM_TAB_INDEX, useFloatingMenuKeys } from './menuFocus.js'
import styles from './Select.module.css'

export type SelectOption<T extends string> = { value: T; label: string; lang?: string }

/**
 * 胶囊形选择器：触发器高 36px、圆角 18px、浅灰底，下拉菜单选中项右侧打勾；
 * 点外部或 Esc 关闭。value 不匹配任何选项时触发器显示 placeholder。
 * 键盘: 展开时聚焦首项, 方向键移动, Enter/Space 选中, Esc/Tab 关闭并交还焦点(见 menuFocus)。
 */
export const Select = <T extends string>({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  className,
  disabled = false,
}: {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  ariaLabel?: string
  className?: string
  disabled?: boolean
}) => {
  const [open, setOpen] = useState(false)
  const current = options.find((option) => option.value === value)
  // 菜单贴右侧展开，最多 320px 高，超出在菜单内滚动
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, { align: 'end', maxHeight: 320, minSpace: 160 })
  const getTrigger = () => anchorRef.current
  // Esc 只关菜单，不让外层弹窗一起关闭; 关闭时若焦点在菜单内则交还触发器
  useDismiss(
    open,
    [anchorRef, floatingRef],
    () => {
      dismissFloating(floatingRef.current, () => setOpen(false), getTrigger)
    },
    { captureEscape: true }
  )
  const onKeyDown = useFloatingMenuKeys({
    open,
    containerRef: floatingRef,
    onClose: () => setOpen(false),
    getTrigger,
  })

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, open && styles.open, className)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {current ? (
          <span lang={current.lang}>{current.label}</span>
        ) : (
          <span className={styles.placeholder}>{placeholder}</span>
        )}
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open && !disabled
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.menu}
              style={position ?? undefined}
              role="listbox"
              aria-label={ariaLabel}
              onKeyDown={onKeyDown}
            >
              {options.map((option) => (
                <div
                  key={option.value}
                  role="option"
                  tabIndex={MENU_ITEM_TAB_INDEX}
                  lang={option.lang}
                  aria-selected={option.value === value}
                  className={styles.option}
                  onClick={() => {
                    setOpen(false)
                    onChange(option.value)
                  }}
                >
                  <span>{option.label}</span>
                  {option.value === value ? <IconCheckOutline16 /> : null}
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
