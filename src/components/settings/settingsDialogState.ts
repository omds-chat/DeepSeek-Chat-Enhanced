import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'
import { selectPanel } from '../plugins/pluginViewState.js'
import { closeMobileSider } from '../sider/mobileSiderState.js'

/** 设置的导航分组：通用设置 / 数据管理 / 插件（settings.page 登记项，没有登记时不出现） */
export type SettingsSection = 'general' | 'data' | 'plugins'

/**
 * 设置的两套状态：
 * open 只服务首启的 API Key 弹窗（设置里唯一的模态例外），
 * section 是设置整页当前选中的分组，打开设置时由调用方指定。
 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

/** 切换分组但不改当前面板：插件分组整块消失时用它回落到通用设置 */
export const selectSettingsSection = (section: SettingsSection) =>
  useSettingsDialog.setState({ section })

/**
 * 打开设置：设置本体是主区整页，与会话、插件面板同一条命名空间，
 * 所以桌面侧边栏底部、移动端侧边栏、401 提示走同一条路径，调用方无需区分设备形态。
 */
export const openSettings = (section: SettingsSection) => {
  useSettingsDialog.setState({ section })
  selectPanel('settings')
  // 移动端从抽屉进入设置时抽屉让位: 设置是一整块主区, 抽屉留着会盖住它
  closeMobileSider()
}

/** 关闭首启的 API Key 弹窗；设置页自身的关闭是 selectPanel(null) */
export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 没有 API Key 时弹出首启填写框，并返回是否已有 Key；已有 Key 时不弹出 */
export const ensureApiKey = () => {
  if (useSettings.getState().apiKey) {
    return true
  }
  useSettingsDialog.setState({ open: true })
  return false
}
