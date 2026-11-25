import { useCallback, useEffect, useRef, useState } from 'react'
import { getPluginEngine } from '../dsc-plugin-engine/index.js'
import type { PluginStateView } from '../dsc-plugin-engine/types.js'

export type PluginListState = {
  /** 引擎当前的插件视图；引擎未就绪时为空数组 */
  plugins: PluginStateView[]
  /** 引擎是否已就绪 */
  ready: boolean
  /** 首读未完成：列表此刻取不到内容，界面显示骨架行而不是空态 */
  loading: boolean
  /** 刚装上、列表还没高亮过的插件 id；消费方展示完调用 clearHighlight */
  highlightId: string | null
  /** 重新读取 engine.list()；每次插件操作后调用 */
  refresh: () => void
  /** 撤掉新装插件的高亮标记 */
  clearHighlight: () => void
}

/** 读取 engine.list()；引擎未就绪或读取失败时给出空列表，不向界面抛错 */
export const usePluginList = (): PluginListState => {
  const [plugins, setPlugins] = useState<PluginStateView[]>([])
  /** 引擎在首屏渲染前已由 main.tsx 安装，初值按实际可读性取，避免先渲染一帧「引擎尚未就绪」 */
  const [ready, setReady] = useState(() => getPluginEngine() !== null)
  /** 首读标记：初值为真，首次 refresh 落定后置假，后续刷新不再让列表退回骨架 */
  const [loading, setLoading] = useState(true)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  /** 上一轮读到的插件 id；null 表示还没有基线，首次读到不产生高亮 */
  const known = useRef<Set<string> | null>(null)

  const refresh = useCallback(() => {
    const engine = getPluginEngine()
    if (!engine) {
      setPlugins([])
      setReady(false)
      setLoading(false)
      return
    }
    let list: PluginStateView[] = []
    try {
      list = engine.list()
    } catch {
      list = []
    }
    setPlugins(list)
    setReady(true)
    setLoading(false)
    // 只有 id 首次出现才算新装：重装与更新沿用同一 id，不触发高亮
    const previous = known.current
    known.current = new Set(list.map((plugin) => plugin.id))
    const added = previous === null ? undefined : list.find((plugin) => !previous.has(plugin.id))
    if (added) {
      setHighlightId(added.id)
    }
  }, [])

  const clearHighlight = useCallback(() => setHighlightId(null), [])

  useEffect(refresh, [refresh])

  return { plugins, ready, loading, highlightId, refresh, clearHighlight }
}
