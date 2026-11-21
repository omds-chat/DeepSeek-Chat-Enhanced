import {
  normalizeSourceDescriptor,
  SOURCE_CAPABILITY_IDS,
  checkSourceDescriptor,
  type CoreSourceDescriptor,
  type SourceCapabilityId,
  type SourceProblem,
} from '../dsc-core/source-catalog.js'

/**
 * 供应端点注册表。
 * 插件只交描述: 引擎按端点 id 合并声明, 能力清单取并集;
 * 定义不一致时判冲突, 未决期先声明的那份临时生效并打上冲突标记。
 * 这里只做描述层面的合并, 不执行任何请求; 执行在 dsc-core 的 source:run 入口。
 * 直接引用 dsc-core 的 source-catalog 而不是门面: 那是纯数据模块, 引用它不会带出 store 与网络层。
 */

/** 冲突字段: 同一端点 id 的两份描述在某项上不一致 */
export type SourceConflictField = 'format' | 'baseUrl' | 'endpoints'

/** 一条冲突记录; kept 是临时生效的那份, rejected 是没生效的那份, 两份都留在声明里 */
export type SourceConflict = {
  readonly sourceId: string
  readonly fields: readonly SourceConflictField[]
  readonly keptOwner: string
  readonly kept: CoreSourceDescriptor
  readonly rejectedOwner: string
  readonly rejected: CoreSourceDescriptor
}

/** 供应端点描述被拒绝; 原因取自 dsc-core 的描述检查, 只有一项 */
export class PluginSourceError extends Error {
  constructor(readonly problem: SourceProblem) {
    super(`dsc-plugin-engine: source declaration rejected (${problem})`)
    this.name = 'PluginSourceError'
  }
}

/** 能力矩阵: 每项能力对应的端点 id, 顺序即端点进入注册表的顺序 */
export type SourceCapabilityMatrix = Readonly<Record<SourceCapabilityId, readonly string[]>>

/** 注册表视图; 界面与引擎内部只读这一份 */
export type SourceRegistryView = {
  readonly sources: readonly CoreSourceDescriptor[]
  /** 端点 id 到声明方插件 id; 定义冲突时冲突方也记在这里, 因此它回答「谁还声明过这个 id」 */
  readonly owners: Readonly<Record<string, readonly string[]>>
  readonly matrix: SourceCapabilityMatrix
  readonly conflicts: readonly SourceConflict[]
}

/** 声明方到声明的供应端点描述; 保留声明顺序, 合并时先声明者先入表 */
const declarations = new Map<string, CoreSourceDescriptor[]>()

/** 两份描述的端点覆盖是否一致; 缺省与空对象等价 */
const endpointsEqual = (left: CoreSourceDescriptor, right: CoreSourceDescriptor): boolean => {
  const keys = new Set([
    ...Object.keys(left.endpoints ?? {}),
    ...Object.keys(right.endpoints ?? {}),
  ])
  for (const key of keys) {
    if (
      left.endpoints?.[key as SourceCapabilityId] !== right.endpoints?.[key as SourceCapabilityId]
    ) {
      return false
    }
  }
  return true
}

/**
 * 定义不一致的字段。
 * 判定只看 format、规范化后的 baseUrl 与 endpoints: 这三项决定请求发到哪里、按什么协议组装。
 * label 只是展示名, 与他人不同不算冲突; 能力清单按并集合并, 也不参与判定。
 */
const differingFields = (
  left: CoreSourceDescriptor,
  right: CoreSourceDescriptor
): SourceConflictField[] => {
  const fields: SourceConflictField[] = []
  if (left.format !== right.format) {
    fields.push('format')
  }
  if (left.baseUrl !== right.baseUrl) {
    fields.push('baseUrl')
  }
  if (!endpointsEqual(left, right)) {
    fields.push('endpoints')
  }
  return fields
}

/** 两份声明是否完全一致; 展示名不同也按同一份声明处理, 能力清单按集合比较 */
const sameDeclaration = (left: CoreSourceDescriptor, right: CoreSourceDescriptor): boolean => {
  if (differingFields(left, right).length > 0) {
    return false
  }
  const leftIds = new Set(left.capabilities)
  if (leftIds.size !== new Set(right.capabilities).size) {
    return false
  }
  return right.capabilities.every((capability) => leftIds.has(capability))
}

/** 一条冲突记录 */
const toConflict = (
  keptOwner: string,
  kept: CoreSourceDescriptor,
  rejectedOwner: string,
  rejected: CoreSourceDescriptor
): SourceConflict => ({
  sourceId: kept.id,
  fields: differingFields(kept, rejected),
  keptOwner,
  kept,
  rejectedOwner,
  rejected,
})

/** 建一张空能力矩阵; 循环覆盖能力表的每一项, 因此查询时不必再判空 */
const emptyMatrix = (): Record<SourceCapabilityId, string[]> => {
  const matrix: Partial<Record<SourceCapabilityId, string[]>> = {}
  for (const capability of SOURCE_CAPABILITY_IDS) {
    matrix[capability] = []
  }
  return matrix as Record<SourceCapabilityId, string[]>
}

/** 按能力表顺序排列能力清单, 便于展示与比较 */
const orderCapabilities = (capabilities: readonly SourceCapabilityId[]): SourceCapabilityId[] => {
  const set = new Set(capabilities)
  return SOURCE_CAPABILITY_IDS.filter((capability) => set.has(capability))
}

type MergedEntry = {
  descriptor: CoreSourceDescriptor
  owners: string[]
  capabilities: Set<SourceCapabilityId>
}

/**
 * 合并全部声明。
 * 同一端点 id 的第二份及以后的声明:
 * 定义一致时把能力并入并记下声明方; 定义不一致时记一条冲突, 能力不并入, 声明方仍然记入 owners。
 * 未决期先声明的那份继续生效, 这样界面能看到"该 id 目前打向哪里", 冲突本身是可见的标记而不是隐身状态。
 */
const merge = (): { entries: Map<string, MergedEntry>; conflicts: SourceConflict[] } => {
  const entries = new Map<string, MergedEntry>()
  const conflicts: SourceConflict[] = []
  for (const [owner, descriptors] of declarations) {
    for (const descriptor of descriptors) {
      const existing = entries.get(descriptor.id)
      if (!existing) {
        entries.set(descriptor.id, {
          descriptor,
          owners: [owner],
          capabilities: new Set(descriptor.capabilities),
        })
        continue
      }
      if (!existing.owners.includes(owner)) {
        existing.owners.push(owner)
      }
      if (differingFields(existing.descriptor, descriptor).length > 0) {
        conflicts.push(toConflict(existing.owners[0], existing.descriptor, owner, descriptor))
        continue
      }
      for (const capability of descriptor.capabilities) {
        existing.capabilities.add(capability)
      }
    }
  }
  return { entries, conflicts }
}

/** 注册表视图; 每次调用都重新合并, 声明数量很少, 不做缓存以免状态不一致 */
export const sourceView = (): SourceRegistryView => {
  const { entries, conflicts } = merge()
  const sources: CoreSourceDescriptor[] = []
  const owners: Record<string, string[]> = {}
  const matrix = emptyMatrix()
  for (const [id, entry] of entries) {
    const capabilities = orderCapabilities([...entry.capabilities])
    sources.push({ ...entry.descriptor, capabilities })
    owners[id] = [...entry.owners]
    for (const capability of capabilities) {
      matrix[capability].push(id)
    }
  }
  return { sources, owners, matrix, conflicts }
}

/** 全部端点描述 */
export const listSources = (): readonly CoreSourceDescriptor[] => sourceView().sources

/** 按 id 取合并后的端点描述 */
export const findSource = (id: string): CoreSourceDescriptor | undefined =>
  sourceView().sources.find((source) => source.id === id)

/** 当前全部冲突 */
export const sourceConflicts = (): readonly SourceConflict[] => sourceView().conflicts

/** 当前能力矩阵 */
export const sourceCapabilityMatrix = (): SourceCapabilityMatrix => sourceView().matrix

/** 提供某项能力的端点 id; 顺序即端点进入注册表的顺序 */
export const sourcesForCapability = (capability: SourceCapabilityId): readonly string[] =>
  sourceView().matrix[capability]

/**
 * 当前选中的供应端点。
 * 本版取「该能力在注册表里的第一个端点」, 先不做用户选择: 端点按声明顺序入表,
 * 因此同一声明序列下选中的端点稳定可复现。后续计划见引擎 README 的「按端点执行」一节。
 */
export const selectedSource = (
  capability: SourceCapabilityId
): CoreSourceDescriptor | undefined => {
  const [first] = sourcesForCapability(capability)
  return first === undefined ? undefined : findSource(first)
}

/**
 * 登记一条供应端点声明。
 * 登记前统一规范化: 描述里的 baseUrl 先过 normalizeSourceDescriptor, 注册表里保存与比对的都是规范化后的值。
 * 完全相同的重复声明按无操作处理; 与已生效的定义不一致时不生效, 返回这条冲突供调用方记日志。
 */
export const declareSource = (
  owner: string,
  descriptor: CoreSourceDescriptor
): readonly SourceConflict[] => {
  const normalized = normalizeSourceDescriptor(descriptor)
  if (!normalized) {
    throw new PluginSourceError(checkSourceDescriptor(descriptor) ?? 'endpoints')
  }
  const owned = declarations.get(owner) ?? []
  if (owned.some((item) => sameDeclaration(item, normalized))) {
    return []
  }
  const view = sourceView()
  const existing = view.sources.find((source) => source.id === normalized.id)
  const conflicts =
    existing && differingFields(existing, normalized).length > 0
      ? [toConflict(view.owners[existing.id]?.[0] ?? owner, existing, owner, normalized)]
      : []
  declarations.set(owner, [...owned, normalized])
  return conflicts
}

/** 撤销某个插件的全部声明; 停用与卸载时调用 */
export const forgetSources = (owner: string): void => {
  declarations.delete(owner)
}

/** 清空注册表; 只给内存夹具使用 */
export const resetSources = (): void => {
  declarations.clear()
}
