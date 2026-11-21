import type { ActivationConflict, PendingConflict } from './types.js'

/**
 * 冲突对多到一屏放不下时，界面默认收起逐条详情，先给汇总句与条数。
 * 门槛取 5：超过 5 条时逐条列表会把「保留哪一个」的按钮挤出首屏。
 */
export const PAIR_DETAIL_LIMIT = 5

/** 是否收起逐条冲突详情 */
export const pairDetailsCollapsed = (pairCount: number): boolean => pairCount > PAIR_DETAIL_LIMIT

const PAIR_KINDS: readonly string[] = ['single', 'mutual']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 收敛一对冲突；kind 不在表内、两边同名或字段不是非空字符串时返回 null */
const readPair = (value: unknown): ActivationConflict | null => {
  if (!isRecord(value)) {
    return null
  }
  const kind = value.kind
  const declarer = value.declarer
  const target = value.target
  if (typeof kind !== 'string' || !PAIR_KINDS.includes(kind)) {
    return null
  }
  if (typeof declarer !== 'string' || declarer === '') {
    return null
  }
  if (typeof target !== 'string' || target === '' || target === declarer) {
    return null
  }
  return { kind: kind as ActivationConflict['kind'], declarer, target }
}

/** 冲突对的去重键；方向进键，单向与双向、两个方向各算一条 */
const pairKey = (pair: ActivationConflict): string =>
  pair.kind + '|' + pair.declarer + '>' + pair.target

/** 收敛一组冲突对；非法项与重复项丢弃，顺序保持原样 */
const readPairs = (values: readonly unknown[]): ActivationConflict[] => {
  const pairs: ActivationConflict[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const pair = readPair(value)
    if (!pair) {
      continue
    }
    const key = pairKey(pair)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    pairs.push(pair)
  }
  return pairs
}

/** 冲突对涉及的插件 id，按字典序去重 */
const pluginsOfPairs = (pairs: readonly ActivationConflict[]): string[] => {
  const ids = new Set<string>()
  for (const pair of pairs) {
    ids.add(pair.declarer)
    ids.add(pair.target)
  }
  return [...ids].sort()
}

/** 组 id：按字典序拼接插件 id，同一组插件永远得到同一个 id */
export const pendingConflictId = (plugins: readonly string[]): string =>
  [...new Set(plugins.filter((id) => id !== ''))].sort().join('+')

/**
 * 收敛一条落盘记录。
 * 插件清单与组 id 都按冲突对重建，避免旧记录里两者与冲突对不一致导致同一组散成两条；
 * 冲突对全部不合法时返回 null，由调用方丢弃该条。
 */
export const readPendingConflict = (value: unknown): PendingConflict | null => {
  if (!isRecord(value)) {
    return null
  }
  const at = value.at
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
    return null
  }
  if (!Array.isArray(value.pairs)) {
    return null
  }
  const pairs = readPairs(value.pairs)
  if (pairs.length === 0) {
    return null
  }
  const plugins = pluginsOfPairs(pairs)
  return { id: pendingConflictId(plugins), plugins, pairs, at }
}

/**
 * 合并一次冲突检测结果。
 * 与已有记录有交集时并入同一条：一次待决定只应对一个连通冲突组，用户选一个保留，其余保持停用。
 * 没有交集时新增一条。结果按检测时间升序，同一时刻按组 id 排序，便于界面稳定展示。
 */
export const mergePendingConflicts = (
  existing: readonly PendingConflict[],
  incoming: readonly ActivationConflict[],
  at: number
): PendingConflict[] => {
  const pairs = readPairs(incoming)
  if (pairs.length === 0) {
    return [...existing]
  }
  const incomingIds = new Set(pluginsOfPairs(pairs))
  const merged = [...pairs]
  const rest: PendingConflict[] = []
  for (const group of existing) {
    if (!group.plugins.some((id) => incomingIds.has(id))) {
      rest.push(group)
      continue
    }
    // 同一组冲突可能被再次检测到：同一对冲突只留最新一份，方向不同则是两条
    merged.push(...group.pairs)
  }
  const deduped = readPairs(merged)
  const plugins = pluginsOfPairs(deduped)
  rest.push({ id: pendingConflictId(plugins), plugins, pairs: deduped, at })
  rest.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))
  return rest
}

/** 清理结果；droppedPairs 与 droppedGroups 用于判断是否需要回写 */
export type PendingConflictPrune = {
  groups: PendingConflict[]
  droppedPairs: number
  droppedGroups: number
}

/**
 * 按已安装插件清理待决定记录。
 * 一条冲突对只要有一方不在已安装集合里就整对丢弃，因为「保留哪一个」已经无从选择；
 * 一条记录的冲突对全部失效时删除该记录本身。记录里的插件已卸载时，这是唯一的清理入口。
 */
export const prunePendingConflicts = (
  groups: readonly PendingConflict[],
  installed: ReadonlySet<string>
): PendingConflictPrune => {
  const kept: PendingConflict[] = []
  let droppedPairs = 0
  let droppedGroups = 0
  for (const group of groups) {
    const pairs = group.pairs.filter(
      (pair) => installed.has(pair.declarer) && installed.has(pair.target)
    )
    droppedPairs += group.pairs.length - pairs.length
    if (pairs.length === 0) {
      droppedGroups += 1
      continue
    }
    const plugins = pluginsOfPairs(pairs)
    kept.push({ id: pendingConflictId(plugins), plugins, pairs, at: group.at })
  }
  return { groups: kept, droppedPairs, droppedGroups }
}

/** 某个插件是否出现在待决定记录里；启动恢复据此跳过自动启用 */
export const isPendingConflictPlugin = (
  groups: readonly PendingConflict[],
  id: string
): boolean => groups.some((group) => group.plugins.includes(id))

/** 两份待决定记录是否等价；用于判断清理与合并是否需要回写 */
export const samePendingConflicts = (
  left: readonly PendingConflict[],
  right: readonly PendingConflict[]
): boolean => {
  if (left.length !== right.length) {
    return false
  }
  return left.every((group, index) => {
    const other = right[index]
    if (
      other === undefined ||
      group.id !== other.id ||
      group.at !== other.at ||
      group.plugins.join('+') !== other.plugins.join('+') ||
      group.pairs.length !== other.pairs.length
    ) {
      return false
    }
    return group.pairs.every((pair, pairIndex) => {
      const peer = other.pairs[pairIndex]
      return (
        peer !== undefined &&
        peer.kind === pair.kind &&
        peer.declarer === pair.declarer &&
        peer.target === pair.target
      )
    })
  })
}
