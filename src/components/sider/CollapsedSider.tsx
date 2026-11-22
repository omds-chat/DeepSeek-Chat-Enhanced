import { IconPanelLeftOutline16, NewChatIcon } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import { SlotPanelList } from './SlotPanelList.js'
import styles from './Sider.module.css'

/**
 * 收起后左上角的按钮组: 导航行(逐面板一个图标)在前, 展开与新对话在后。
 * 收起态保留每个面板一个入口, 推翻此前「收起态不为插件入口另设图标」的决定:
 * dsh 的收起 rail 恰好是逐面板一个图标(面板行 wide=false 只画图标),
 * 收起后没有入口意味着插件面板与全部插件页面只能靠展开侧栏到达, 一整类导航凭空消失;
 * 图标加悬停提示足够表达去向, 收起态的横向空间也因此省得下。
 */
export const CollapsedSider = () => {
  const t = useTranslate()
  return (
    <div className={styles.collapsed}>
      <SlotPanelList wide={false} />
      <div className={styles.collapsedGroup}>
        <IconButton
          size="m"
          tone="primary"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('expandSiderbarButton')}
          onClick={() => setSiderCollapsed(false)}
        />
        {/* 新对话本身就会回到会话视图(见 services/chat/store.ts 的 newChat) */}
        <IconButton
          size="m"
          tone="primary"
          icon={<NewChatIcon />}
          tooltip={t('newChat')}
          onClick={newChat}
        />
      </div>
    </div>
  )
}
