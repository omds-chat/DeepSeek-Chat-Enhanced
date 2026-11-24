import { createContext, useContext } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconChevronDownOutline14 } from '../base/icons.js'
import styles from './BackToBottom.module.css'

/**
 * 回到底部悬浮钮: 离底超过一屏时露出, 点击把阅读位置送回最新消息。
 * 显隐与强制回底由消息列表决定(它持有滚动引用), 经上下文交给按钮;
 * 按钮挂在吸底座位内部, 定位父级是座位本身, 所以它不随正文滚动。
 */

type BackToBottomState = {
  visible: boolean
  scrollToBottom: () => void
}

/** 未接入消息列表时按钮不存在: 既不显示也不响应 */
const IDLE_STATE: BackToBottomState = {
  visible: false,
  scrollToBottom: () => {},
}

export const BackToBottomContext = createContext<BackToBottomState>(IDLE_STATE)

export const BackToBottom = () => {
  const t = useTranslate()
  const { visible, scrollToBottom } = useContext(BackToBottomContext)
  if (!visible) {
    return null
  }
  return (
    <button
      type="button"
      className={styles.button}
      aria-label={t('backToBottom')}
      onClick={scrollToBottom}
    >
      <IconChevronDownOutline14 />
    </button>
  )
}
