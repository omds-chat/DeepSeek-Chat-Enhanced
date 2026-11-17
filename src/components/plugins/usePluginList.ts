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
  const [ready, setReady] = useState(false)

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
