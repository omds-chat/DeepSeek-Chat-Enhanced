import { create } from 'zustand'

/**
 * 资产下载悬浮卡片的状态。
 * 每一次实际发生的传输都用气泡通知 + 这张卡片提示: 不去重、不按来源合并;
 * 同一插件同一时刻只显示一张卡片, 多资产复用; 完成后由引擎收起。
 * 状态只是事实登记, 渲染与取消按钮在宿主组件, 插件不接触这里。
 */

/** 一张卡片的事实数据; 同一插件一条 */
export type DownloadCardData = {
  /** 发起下载的插件 id */
  pluginId: string
  /** 插件展示名; 文案里的插件名由宿主渲染, 不由插件拼装 */
  pluginName: string
  /** 当前传输的资产标识 */
  assetId: string
  /** 来源地址; 声明体积之外的现场信息都在卡片上给全 */
  url: string
  /** 清单声明的体积(字节) */
  declaredBytes: number
  /** 已收字节; 读取进度按它更新 */
  receivedBytes: number
}

type DownloadCardState = {
  /** 按插件 id 一张卡片; 没有活跃传输的插件不在表里 */
  cards: Record<string, DownloadCardData>
}

/** 下载卡片状态; 宿主订阅它渲染右下角悬浮卡片 */
export const useDownloadCards = create<DownloadCardState>(() => ({ cards: {} }))

/** 更新一张卡片的进度; 同一插件同一时刻只有一条, 多资产复用直接覆盖 */
const setCard = (data: DownloadCardData): void => {
  useDownloadCards.setState((state) => ({
    cards: { ...state.cards, [data.pluginId]: data },
  }))
}

/** 收起一个插件的卡片; 传输成功或失败后都由引擎调用 */
const dropCard = (pluginId: string): void => {
  useDownloadCards.setState((state) => {
    if (!(pluginId in state.cards)) {
      return state
    }
    // 动态 delete 会触发 oxlint 的 no-dynamic-delete, 这里用重建对象的方式收起
    const cards: Record<string, DownloadCardData> = {}
    for (const [id, card] of Object.entries(state.cards)) {
      if (id !== pluginId) {
        cards[id] = card
      }
    }
    return { cards }
  })
}

/** 下载卡片的引擎侧出口; 形态与 assetDownload.ts 的 DownloadCardSink 对应 */
export type DownloadCardStore = {
  onStart: (data: DownloadCardData) => void
  onProgress: (data: DownloadCardData) => void
  onSettled: (pluginId: string) => void
  onCancel: (pluginId: string, assetId: string) => void
}

/** 用户点卡片取消按钮的回调; 由宿主装配, 引擎把取消意图交回下载执行器 */
let cancelHandler: ((pluginId: string, assetId: string) => void) | null = null

/** 装配下载卡片的引擎侧出口; 引擎启动时调用一次 */
export const createDownloadCardStore = (
  onCancel: (pluginId: string, assetId: string) => void
): DownloadCardStore => {
  cancelHandler = onCancel
  return {
    onStart: (data) => setCard({ ...data, receivedBytes: 0 }),
    onProgress: (data) => setCard(data),
    onSettled: (pluginId) => dropCard(pluginId),
    onCancel: (pluginId, assetId) => cancelHandler?.(pluginId, assetId),
  }
}

/** 供宿主取消按钮使用: 触发引擎侧的取消回调 */
export const cancelDownload = (pluginId: string, assetId: string): void => {
  cancelHandler?.(pluginId, assetId)
}

/** 字节数的展示形态: 1 MB 以下按 KB, 其余按 MB, 一位小数 */
export const formatAssetBytes = (bytes: number): string => {
  if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(1) + ' KB'
  }
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}
