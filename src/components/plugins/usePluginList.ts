import { useCallback, useEffect, useState } from 'react'
import { getPluginEngine } from '../dsc-plugin-engine/index.js'
import type { PluginStateView } from '../dsc-plugin-engine/types.js'

export type PluginListState = {
  /** 引擎当前的插件视图；引擎未就绪时为空数组 */
  plugins: PluginStateView[]
  /** 引擎是否已就绪 */
  ready: boolean
  /** 重新读取 engine.list()；每次插件操作后调用 */
  refresh: () => void
}

/** 读取 engine.list()；引擎未就绪或读取失败时给出空列表，不向界面抛错 */
export const usePluginList = (): PluginListState => {
  const [plugins, setPlugins] = useState<PluginStateView[]>([])
  /** 引擎在首屏渲染前已由 main.tsx 安装，初值按实际可读性取，避免先渲染一帧「引擎尚未就绪」 */
  const [ready, setReady] = useState(() => getPluginEngine() !== null)

  const refresh = useCallback(() => {
    const engine = getPluginEngine()
    if (!engine) {
      setPlugins([])
      setReady(false)
      return
    }
    try {
      setPlugins(engine.list())
    } catch {
      setPlugins([])
    }
    setReady(true)
  }, [])

  useEffect(refresh, [refresh])

  return { plugins, ready, refresh }
}
