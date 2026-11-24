import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

/*
 * 菜单类浮层(下拉菜单、右键菜单、选择器下拉)共用的键盘闭环:
 * 展开时聚焦首项, 方向键在启用项之间移动, Enter/Space 触发当前项,
 * Esc 与 Tab 关闭并把焦点交回触发元素。
 * 菜单项本身不进 Tab 顺序, 焦点即游标, 因此不需要 aria-activedescendant。
 */

/** 可聚焦元素; 同时用于从包裹层里找出真正的触发元素 */
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** 参与轮转的项: 禁用项(aria-disabled 或 disabled)直接跳过 */
const ITEM_SELECTOR =
  '[role="menuitem"]:not([aria-disabled="true"]):not([disabled]), ' +
  '[role="option"]:not([aria-disabled="true"]):not([disabled])'

/** 菜单项的 tabIndex: 整个菜单不进 Tab 顺序, 项由展开时的聚焦与方向键进入 */
export const MENU_ITEM_TAB_INDEX = -1

const enabledItems = (container: HTMLElement | null): HTMLElement[] =>
  container ? Array.from(container.querySelectorAll<HTMLElement>(ITEM_SELECTOR)) : []

/**
 * 把焦点交回触发元素: 元素自身可聚焦就直接聚焦, 否则(如包裹按钮的 span)
 * 取它第一个可聚焦后代。
 */
export const focusTrigger = (target: HTMLElement | null) => {
  if (!target) {
    return
  }
  const element = target.matches(FOCUSABLE) ? target : target.querySelector<HTMLElement>(FOCUSABLE)
  if (!element) {
    return
  }
  element.focus()
  if (document.activeElement === element || element.contains(document.activeElement)) {
    return
  }
  /*
   * 触发元素被 CSS 隐藏时(如只在悬停或聚焦时显示的行内按钮) focus 不生效,
   * 退到最近的可聚焦祖先, 避免焦点顺着被卸载的浮层落到 body。
   */
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.tabIndex >= 0) {
      parent.focus()
      return
    }
  }
}

/**
 * 关闭浮层, 并在焦点原本位于浮层内时交还焦点:
 * 指针点向别处触发的关闭不把焦点抢回触发元素。
 */
export const dismissFloating = (
  container: HTMLElement | null,
  onClose: () => void,
  getTrigger: () => HTMLElement | null
) => {
  const inside = container !== null && container.contains(document.activeElement)
  onClose()
  if (inside) {
    focusTrigger(getTrigger())
  }
}

export type FloatingMenuKeysOptions = {
  /** 浮层是否展开 */
  open: boolean
  /** 浮层容器(role=menu 或 role=listbox 的根节点) */
  containerRef: RefObject<HTMLElement | null>
  /** 关闭浮层, 与组件自身的 setOpen(false) 等价 */
  onClose: () => void
  /** 焦点归还目标; 取不到时返回 null */
  getTrigger: () => HTMLElement | null
  /** 展开时是否聚焦首项; 由指针静默展开的浮层可传 false */
  focusOnOpen?: boolean
}

/**
 * 返回挂在浮层容器上的 keydown 处理。
 * 浮层挂在 body 上, 与触发元素不在同一个 Tab 顺序里, 所以键盘入口必须显式接管。
 */
export const useFloatingMenuKeys = ({
  open,
  containerRef,
  onClose,
  getTrigger,
  focusOnOpen = true,
}: FloatingMenuKeysOptions) => {
  useEffect(() => {
    if (!open || !focusOnOpen) {
      return
    }
    const [first] = enabledItems(containerRef.current)
    first?.focus()
  }, [containerRef, focusOnOpen, open])

  return (event: ReactKeyboardEvent<HTMLElement>) => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const items = enabledItems(container)
    if (items.length === 0) {
      return
    }
    const current = items.indexOf(document.activeElement as HTMLElement)

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next =
        current < 0
          ? step > 0
            ? 0
            : items.length - 1
          : (current + step + items.length) % items.length
      items[next]?.focus()
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const edge = event.key === 'Home' ? items[0] : items[items.length - 1]
      edge?.focus()
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      /*
       * 项上的 onClick 已经包含「关闭 + 执行」, 键盘走同一条路径;
       * 触发后浮层会卸载, 焦点先交回触发元素, 免得掉到 body。
       */
      event.preventDefault()
      if (current >= 0) {
        items[current]?.click()
        focusTrigger(getTrigger())
      }
      return
    }
    if (event.key === 'Tab' || event.key === 'Escape') {
      /*
       * Tab: 焦点先回到触发元素, 浏览器的默认 Tab 再从那里继续走下一站;
       * 两条路都不把焦点留在即将卸载的菜单里。
       */
      dismissFloating(container, onClose, getTrigger)
    }
  }
}
