/*
 * 输入模态: 在 <html> 上维护 data-input-modality="pointer|keyboard"，
 * 供全局焦点环规则判断「当前是鼠标还是键盘在操作」。只上报状态，不含样式。
 */

type InputModality = 'pointer' | 'keyboard'

const MODALITY_ATTR = 'data-input-modality'

/*
 * 会改变焦点位置的键: Tab 与方向键是主路径，其余是翻页与行首行尾导航。
 * 普通字符键不切换模态，避免在输入框内打字时误判为键盘导航。
 */
const NAVIGATION_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

const publish = (modality: InputModality) => {
  const root = document.documentElement
  if (root.getAttribute(MODALITY_ATTR) !== modality) {
    root.setAttribute(MODALITY_ATTR, modality)
  }
}

const onPointerDown = () => publish('pointer')

const onKeyDown = (event: KeyboardEvent) => {
  if (NAVIGATION_KEYS.has(event.key)) {
    publish('keyboard')
  }
}

/*
 * 首屏按键盘模态起步，未发生指针交互前焦点环可见；之后随最近一次输入方式切换。
 * 只注册一次，监听挂在 document 上，捕获阶段生效，避免被组件内部的 stopPropagation 吞掉。
 */
export const setupInputModality = () => {
  publish('keyboard')
  document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
  document.addEventListener('keydown', onKeyDown, { capture: true })
}
