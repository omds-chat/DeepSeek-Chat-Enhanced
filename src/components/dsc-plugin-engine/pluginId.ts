/**
 * 插件 id 规则：与清单校验一致，小写字母开头，只允许小写字母、数字与连字符，长度 3 到 64。
 * 离线包、在线安装与插件市场共用这一处实现，同一插件经不同路径得到同一个 id。
 */
const ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/

/** 只看字符形态；用来区分「字符不合规」与「长度不合规」 */
const ID_CHARSET = /^[a-z][a-z0-9-]*$/

/** 收敛结果不合规的原因 */
export type PluginIdProblem = 'charset' | 'length'

/** 把插件名收敛成 id 形状；@scope/name 取 name 部分，不做合法性判定 */
const converge = (name: string): string => {
  const slash = name.startsWith('@') ? name.indexOf('/') : -1
  const base = slash >= 0 ? name.slice(slash + 1) : name
  return base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** 校验已收敛的 id；合规返回 null */
export const pluginIdProblem = (id: string): PluginIdProblem | null => {
  if (ID_PATTERN.test(id)) {
    return null
  }
  return ID_CHARSET.test(id) ? 'length' : 'charset'
}

/** 把插件名收敛成引擎接受的插件 id；@scope/name 取 name 部分，无法收敛时返回 null */
export const toPluginId = (name: string): string | null => {
  const id = converge(name)
  return pluginIdProblem(id) === null ? id : null
}

/**
 * 收敛后立即按清单规则校验，不合规时给出指向插件命名的说明。
 * 合规返回 null；离线包预检与安装拒绝把这个说明写进 detail，避免只报通用的清单非法。
 */
export const pluginIdProblemText = (name: string): string | null => {
  const id = converge(name)
  const problem = pluginIdProblem(id)
  if (problem === null) {
    return null
  }
  const found = id === '' ? 'an empty id' : `id "${id}"`
  return problem === 'length'
    ? `plugin name "${name}" converges to ${found}, which must be 3 to 64 characters; rename the plugin`
    : `plugin name "${name}" converges to ${found}, which must start with a lowercase letter and use only lowercase letters, digits and hyphens; rename the plugin`
}
