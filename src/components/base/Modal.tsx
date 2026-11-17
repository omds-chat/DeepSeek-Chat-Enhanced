import clsx from 'clsx'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from './icons.js'
import { IconButton } from './IconButton.js'
import styles from './Modal.module.css'

/** 当前打开的弹窗，后打开的在末尾；叠放时 Esc 与焦点陷阱只作用于最上层 */
const openModals: object[] = []

/** 参与循环的可聚焦元素；禁用与 tabindex="-1" 的元素不参与 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** 收集容器内当前可见的可聚焦元素 */
const focusableIn = (container: HTMLElement): HTMLElement[] =>
  [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => element.getClientRects().length > 0
  )

/** Tab 与 Shift+Tab 在弹窗内首尾循环；焦点落在容器自身或弹窗之外时按边界处理 */
const trapTab = (event: KeyboardEvent, container: HTMLElement | null): void => {
  if (!container) {
    return
  }
  const items = focusableIn(container)
  if (items.length === 0) {
    // 没有可聚焦元素时焦点固定在容器上，Tab 不回到背景页面
    event.preventDefault()
    container.focus()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  const inside = active !== null && container.contains(active)
  if (event.shiftKey) {
    if (!inside || active === first || active === container) {
      event.preventDefault()
      last.focus()
    }
    return
  }
  if (!inside || active === last || active === container) {
    event.preventDefault()
    first.focus()
  }
}

/** 遮罩 + 居中卡片，Esc / 点遮罩关闭；打开时移入焦点并循环 Tab，关闭时归还焦点 */
export const Modal = ({
  title,
  children,
  footer,
  closable = false,
  className,
  mainClassName,
  onClose,
}: {
  title: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** 标题栏右侧显示关闭按钮 */
  closable?: boolean
  className?: string
  /** 内容区的 class */
  mainClassName?: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const titleId = useId()
  const contentRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const token = {}
    const container = contentRef.current
    const previous = document.activeElement
    openModals.push(token)
    // 子元素用 autoFocus 在提交阶段已经把焦点放进弹窗时保持不动，避免覆盖
    const claimed =
      container !== null &&
      previous !== null &&
      previous !== container &&
      container.contains(previous)
    if (!claimed) {
      // 初始焦点：弹窗内第一个可聚焦元素，没有则落在容器上
      const initial = container ? (focusableIn(container)[0] ?? container) : null
      initial?.focus()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // 叠放时只有最上层响应 Esc 与 Tab，下层弹窗保持不动
      if (openModals.at(-1) !== token) {
        return
      }
      if (event.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (event.key === 'Tab') {
        trapTab(event, container)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      const index = openModals.indexOf(token)
      if (index !== -1) {
        openModals.splice(index, 1)
      }
      document.removeEventListener('keydown', onKeyDown)
      // 归还焦点；打开前的元素可能已从文档中移除，此时跳过。
      // StrictMode 下本清理会紧接着再执行一次挂载，归还后新的挂载会重新记录同一个元素
      if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected) {
        previous.focus()
      }
    }
  }, [])

  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={contentRef}
        className={clsx(styles.content, className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className={styles.header}>
          <div id={titleId} className={styles.title}>
            {title}
          </div>
          {closable ? (
            <IconButton
              className={styles.close}
              tone="primary"
              icon={<IconCloseOutline16 />}
              aria-label={t('close')}
              onClick={onClose}
            />
          ) : null}
        </div>
        {children ? <div className={clsx(styles.main, mainClassName)}>{children}</div> : null}
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>,
    document.body
  )
}
