import clsx from 'clsx'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { ConversationTabs } from '../plugins/ConversationTabs.js'
import { SessionPanel, SessionPanelToggle } from '../plugins/SessionPanel.js'
import { useSlotPanels } from '../plugins/useSlotPanels.js'
import { BackToBottom } from './BackToBottom.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './SessionView.module.css'

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const title = session.title || t('untitledChat')
  /* 没有插件登记 conversation.tabs 时页签行不存在, 页头随之塌一档, 不留空行 */
  const hasTabs = useSlotPanels().some((item) => item.slot === 'conversation.tabs')
  return (
    <div className={styles.view}>
      {isMobile ? (
        <>
          <MobileHeader title={title} />
          {/* 会话视图标签栏属于会话自身的页头，不单独占一行主区 */}
          <ConversationTabs />
        </>
      ) : (
        <div className={clsx(styles.header, !hasTabs && styles.headerCompact)}>
          <div className={styles.titleRow}>
            <div className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}>
              {title}
            </div>
            {/* 右栏开关: 没有插件登记右栏内容时自己退出, 页头与既有外观一致 */}
            <SessionPanelToggle />
          </div>
          {/* 页签落在标题行下方, 左对齐; 收起侧栏时与标题同一让位 */}
          {hasTabs ? (
            <div className={clsx(styles.tabsRow, siderCollapsed && styles.withCollapsedSider)}>
              <ConversationTabs />
            </div>
          ) : null}
        </div>
      )}
      {/* 右栏只在有 session.panel.section 或 nav.side 登记时占宽, 否则这段包装不改变既有版面 */}
      <div className={styles.body}>
        <div className={styles.conversation}>
          <MessageList
            session={session}
            streaming={streaming}
            footer={
              <div className={styles.inputContainer}>
                {/* 回到底部钮挂在吸底座位内: 定位父级是不随正文滚动的座位 */}
                <BackToBottom />
                <ChatInput sessionId={session.id} />
                <div className={styles.caveat}>{t('contentCaveat')}</div>
              </div>
            }
          />
        </div>
        <SessionPanel />
      </div>
    </div>
  )
}
