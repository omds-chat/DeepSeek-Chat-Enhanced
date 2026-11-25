import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  market,
  type CatalogPlugin,
  type MarketClient,
  type SourceRuntime,
} from '../dsc-market/index.js'
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

/** 内置内部插件来源的目录：来源 id 与它拉到的条目 */
export type InternalCatalog = { sourceId: string; plugins: CatalogPlugin[] }

/** 市场客户端缺失时的占位订阅源，保证 Hook 顺序稳定 */
const EMPTY_STORE = { subscribe: () => () => undefined, version: () => 0 }

/**
 * 内置内部插件来源的运行态；没有 inner 来源或该来源还没拉取过时为 null。
 * 按 kind 取而不是按顺序取：内置来源有内部插件与社区两条，
 * 「第一条内置来源」在顺序变化时会错拿成社区来源。
 */
const internalRuntimeOf = (client: MarketClient | null): SourceRuntime | null => {
  if (client === null) {
    return null
  }
  const source = client.sources().find((item) => item.kind === 'inner')
  return source ? client.runtime(source.id) : null
}

/**
 * 内置内部插件来源的目录条目；市场未就绪或该来源还没有运行态时返回 null。
 * 来源按 kind 认，不按数组顺序、也不按 id 硬编码。
 * 快照取的是来源运行态本身：客户端按版本缓存它，引用稳定，来源拉取完成后这一组自己出现。
 */
export const useInternalCatalog = (): InternalCatalog | null => {
  const client = market()
  const store = client ?? EMPTY_STORE
  const snapshot = () => internalRuntimeOf(client)
  const runtime = useSyncExternalStore(store.subscribe, snapshot, snapshot)
  return useMemo(
    () => (runtime === null ? null : { sourceId: runtime.id, plugins: runtime.plugins }),
    [runtime]
  )
}