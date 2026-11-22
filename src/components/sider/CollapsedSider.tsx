import { IconPanelLeftOutline16, IconPluginOutline16, NewChatIcon } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { newChat, useChatStore } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import { openPluginPanel, returnToChat, usePluginView } from '../plugins/pluginViewState.js'
import styles from './Sider.module.css'

/**
 * 收起后左上角的按钮组。
 * 只保留展开、新对话与插件面板三个入口：插件视图是会话视图的一种，入口在展开后的列表里，
 * 收起态不为它另设图标，免得收起后凭空多出一个不知道通向哪里的按钮。
 */
export const CollapsedSider = () => {
  const t = useTranslate()
  const view = usePluginView((state) => state.view)
  const activeId = useChatStore((state) => state.activeId)
  return (
    <div className={styles.collapsed}>
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
        <IconButton
          size="m"
          tone="primary"
          icon={<IconPluginOutline16 />}
          tooltip={t('pluginPanelTitle')}
          onClick={() =>
            view.kind === 'panel' ? returnToChat() : openPluginPanel('installed', activeId)
          }
        />
      </div>
    </div>
  )
}
