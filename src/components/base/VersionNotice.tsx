import { useTranslate } from '../../i18n/index.js'
import {
  dismissPageVersionNotice,
  openPreviousVersionPage,
  refreshToLatestPage,
  usePageVersion,
} from '../../services/pageVersion.js'
import { Button } from './Button.js'
import styles from './VersionNotice.module.css'

/** 版本不一致时的飘窗提示：提供刷新到最新版、打开旧版本与稍后处理，不遮挡页面操作 */
export const VersionNotice = () => {
  const t = useTranslate()
  const pending = usePageVersion((state) => state.pending)
  if (pending === null) {
    return null
  }
  return (
    <div className={styles.notice} role="status">
      <div className={styles.title}>{t('pageVersionTitle')}</div>
      <div className={styles.body}>
        {t('pageVersionBody', { current: pending.current, previous: pending.previous })}
      </div>
      <div className={styles.actions}>
        <Button size="s" onClick={refreshToLatestPage}>
          {t('pageVersionRefresh')}
        </Button>
        <Button size="s" variant="outlined" onClick={openPreviousVersionPage}>
          {t('pageVersionOpenPrevious')}
        </Button>
        <Button size="s" variant="outlined" onClick={dismissPageVersionNotice}>
          {t('pageVersionLater')}
        </Button>
      </div>
    </div>
  )
}
