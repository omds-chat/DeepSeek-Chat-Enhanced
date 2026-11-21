import type { DeactivateOptions, PluginState, PluginStateView } from './types.js'

/**
 * 依赖关系计算只需要三项：插件 id、运行状态与清单依赖。
 * 注册表记录与插件视图都满足这一形态，停用前置检查与已安装列表的徽标因此共用同一份判定。
 */
export type DependencyNode = {
  id: string
  state: PluginState
  dependencies: readonly string[]
}

/** 单个插件的依赖关系状态 */
export type DependencyStatus = {
  /** 未安装或未启用的依赖 id；按清单顺序去重后给出 */
  missing: string[]
  /** 处于启用状态、依赖本插件的插件 id；按 id 排序 */
  dependents: string[]
  /** 依赖未满足；启用会被拒，启用按钮据此置灰 */
  dependencyMissing: boolean
  /** 被已启用的插件依赖；停用与卸载都会被拒 */
  dependentBlocked: boolean
}

/** 按 id 建索引，便于一次算出整张列表的依赖关系 */
export const dependencyNodes = (
  nodes: readonly DependencyNode[]
): Map<string, DependencyNode> => new Map(nodes.map((node) => [node.id, node]))

/** 把插件视图收敛成计算用的节点 */
export const nodesOf = (views: readonly PluginStateView[]): DependencyNode[] =>
  views.map((view) => ({ id: view.id, state: view.state, dependencies: view.dependencies }))

/** 未满足的依赖：没有登记记录，或记录不处于启用状态 */
export const missingDependencies = (node: DependencyNode, index: Map<string, DependencyNode>): string[] => {
  const missing: string[] = []
  for (const id of node.dependencies) {
    if (missing.includes(id)) {
      continue
    }
    if (index.get(id)?.state !== 'active') {
      missing.push(id)
    }
  }
  return missing
}

/** 已启用的依赖方：处于启用状态、且清单依赖该插件的其他插件 */
export const activeDependents = (id: string, nodes: readonly DependencyNode[]): string[] =>
  nodes
    .filter((node) => node.id !== id && node.state === 'active' && node.dependencies.includes(id))
    .map((node) => node.id)
    .sort()

/** 单个插件的依赖关系状态；id 不存在时按无依赖、无依赖方处理 */
export const dependencyStatusOf = (
  id: string,
  nodes: readonly DependencyNode[],
  index: Map<string, DependencyNode> = dependencyNodes(nodes)
): DependencyStatus => {
  const node = index.get(id) ?? { id, state: 'registered' as PluginState, dependencies: [] }
  const missing = missingDependencies(node, index)
  const dependents = activeDependents(id, nodes)
  return {
    missing,
    dependents,
    dependencyMissing: missing.length > 0,
    dependentBlocked: dependents.length > 0,
  }
}

/** 整张列表的依赖关系状态；已安装列表的徽标按它逐条取值 */
export const dependencyStatusMap = (
  nodes: readonly DependencyNode[]
): Map<string, DependencyStatus> => {
  const index = new Map(nodes.map((node) => [node.id, node]))
  return new Map(nodes.map((node) => [node.id, dependencyStatusOf(node.id, nodes, index)]))
}

/** 停用结论；depended-on 表示仍有已启用的插件依赖它 */
export type DeactivateCheck =
  | { ok: true }
  | { ok: false; reason: 'depended-on'; dependents: string[]; forced: boolean }

/**
 * 停用前置检查：存在处于启用状态、依赖本插件的插件时拒绝。
 * 强制标志只表示用户明确要求强行停用，不改变结论，也不连带停用依赖方：
 * 关联停用由用户自己完成，引擎不做级联。
 */
export const checkDeactivatable = (
  id: string,
  nodes: readonly DependencyNode[],
  options: DeactivateOptions = {}
): DeactivateCheck => {
  const dependents = activeDependents(id, nodes)
  if (dependents.length === 0) {
    return { ok: true }
  }
  return { ok: false, reason: 'depended-on', dependents, forced: options.force === true }
}
