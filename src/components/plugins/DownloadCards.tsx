import { useTranslate } from '../../i18n/index.js'
import { cancelDownload, formatAssetBytes, useDownloadCards } from '../dsc-plugin-engine/downloadCard.js'
import styles from './DownloadCards.module.css'

/**
 * 资产下载悬浮卡片: 右下角, 每个发起下载的插件一张。
 * 卡片只显示事实: 插件名、资产标识、声明体积与来源地址, 已收字节随进度更新;
 * 取消按钮经引擎侧出口中止底层请求, 完成或失败后卡片由引擎收起, 这里不自行判定状态。
 * 提示不是审批: 卡片不阻塞调用, 也不提供「允许一次」之类的选择。
 */
export const DownloadCards = () => {
  const t = useTranslate()
  const cards = useDownloadCards((state) => state.cards)
  const entries = Object.values(cards)
  if (entries.length === 0) {
    return null
  }
  return (
    <div className={styles.stack} role="status" aria-live="polite">
      {entries.map((card) => (
        <div key={card.pluginId} className={styles.card}>
          <div className={styles.head}>{card.pluginName}</div>
          <div className={styles.row}>{card.assetId}</div>
          <div className={styles.row}>
            {t('pluginAssetDownloadCardReceived', {
              received: formatAssetBytes(card.receivedBytes),
              declared: formatAssetBytes(card.declaredBytes),
            })}
          </div>
          <div className={styles.url}>{card.url}</div>
          <button
            type="button"
            className={styles.cancel}
            onClick={() => cancelDownload(card.pluginId, card.assetId)}
          >
            {t('pluginAssetDownloadCancel')}
          </button>
        </div>
      ))}
    </div>
  )
}
