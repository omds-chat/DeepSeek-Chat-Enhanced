/**
 * 插件 id 规则：小写字母开头，只允许小写字母、数字与连字符。
 * 离线包、在线安装与插件市场共用这一处实现，同一插件经不同路径得到同一个 id。
 */
const ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** 把插件名转成引擎接受的插件 id；@scope/name 取 name 部分，无法收敛时返回 null */
export const toPluginId = (name: string): string | null => {
  const slash = name.startsWith('@') ? name.indexOf('/') : -1
  const base = slash >= 0 ? name.slice(slash + 1) : name
  const id = base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return ID_PATTERN.test(id) ? id : null
}
