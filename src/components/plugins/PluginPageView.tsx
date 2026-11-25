import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { MobileHeader } from '../session/MobileHeader.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { useIsMobile } from '../../app/viewport.js'
import { returnToChat, type SlotPageRef } from './pluginViewState.js'
import { ConversationTabs } from './ConversationTabs.js'
import { PluginPageBody, useSlotPageModel } from './PluginPageBlocks.js'
import detailStyles from './settings/PluginSettings.module.css'
import styles from './PluginPageView.module.css'

/**
 * 插件槽位页面：主区渲染一个已登记的插件页面。
 * 入口是侧边栏导航行(nav.panel)或会话视图标签栏(conversation.tabs); 选中即整块替换主区,
 * 不做路由、不做模态遮罩。
 * 回到会话的方式分两种: 会话标签页靠标签栏自身的「对话」项, 其它槽位(如 nav.panel)没有标签栏,
 * 由页头左上角的返回按钮回到会话。
 * 页面内容与表单模型的实现在 PluginPageBlocks.tsx, 与设置对话框里的 settings.page 共用一份。
 */
export const PluginPageView = ({
  page,
  siderCollapsed,
}: {
  page: SlotPageRef
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const { state, model, pluginName, snapshot, formModel, runAction } = useSlotPageModel(page)

  return (
    <div className={detailStyles.page}>
      {isMobile ? <MobileHeader /> : null}
      {/* 侧边栏收起后左上角是悬浮按钮组，面包屑必须让开，否则会压在按钮下面 */}
      <div className={clsx(detailStyles.header, siderCollapsed && styles.headerCollapsed)}>
        {/* 会话标签页的「返回会话」由标签栏的「对话」项承担, 只有其它槽位保留这个页头按钮 */}
        {page.slot !== 'conversation.tabs' ? (
          // 返回一律回到会话: 纯面板导航, 不恢复进入前的会话, 不触发会话读取
          <button type="button" className={styles.crumb} onClick={() => returnToChat()}>
            <span className={styles.crumbIcon} aria-hidden="true">
              <IconChevronRightOutline14 />
            </span>
            {t('pluginViewBackToChat')}
          </button>
        ) : null}
        {/* 会话标签页与全局面板页共用页头, 标签栏只在会话标签页出现, 位置与会话视图一致 */}
        {page.slot === 'conversation.tabs' ? <ConversationTabs /> : null}
      </div>
      {state.kind === 'loading' ? (
        <div className={detailStyles.loading}>{t('pluginPagesLoading')}</div>
      ) : state.kind === 'missing' || !model ? (
        <div className={detailStyles.empty}>{t('pluginPagesLoadFailed')}</div>
      ) : (
        <PluginPageBody
          model={model}
          pluginName={pluginName}
          snapshot={snapshot}
          formModel={formModel}
          runAction={runAction}
        />
      )}
    </div>
  )
}
