import type { UpdateCheck, UpdateTarget } from './types.js'

/** 产物文件名；版本目录里固定叫这个名字 */
const PLUGIN_FILE = 'plugin.js'
/** 合集根目录名；来源根目录就在它之前的一级 */
const PLUGIN_ROOT = 'plugins'
/** 三段版本号；与市场解析 versions.json 的口径一致 */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** 拼接地址；base 已保证以斜杠结尾 */
const joinUrl = (base: string, path: string): string => {
  try {
    return new URL(path, base).href
  } catch {
    return base + path
  }
}

const withTrailingSlash = (value: string): string => (value.endsWith('/') ? value : value + '/')

/**
 * 由已安装记录的 plugin.js 地址推导数据基址，即该版本的目录地址。
 * 地址不是产物地址时返回 null，由调用方按「无法判断」处理。
 */
export const deriveDataBase = (sourceUrl: string): string | null => {
  let target: URL
  try {
    target = new URL(sourceUrl)
  } catch {
    return null
  }
  if (!target.pathname.endsWith('/' + PLUGIN_FILE)) {
    return null
  }
  // 只保留目录部分，查询与哈希随之丢弃
  return target.origin + target.pathname.slice(0, -PLUGIN_FILE.length)
}

/** 已安装插件的地址结构；版本目录由插件目录与版本号拼出 */
export type InstalledLocation = {
  /** 插件目录（版本目录的上一级），以斜杠结尾；versions.json 在这一级 */
  pluginDir: string
  /** 来源根目录，即 plugins 之前的一级，以斜杠结尾 */
  root: string
  /** 作者名，用于拼作者公钥地址 */
  author: string
}

/** 由数据基址反推插件目录、来源根目录与作者；结构不符返回 null */
export const locateInstalled = (dataBase: string): InstalledLocation | null => {
  let target: URL
  try {
    target = new URL(withTrailingSlash(dataBase))
  } catch {
    return null
  }
  const segments = target.pathname.split('/').filter((segment) => segment !== '')
  const count = segments.length
  // 至少要有 plugins/<author>/<name>/<version> 四段
  if (count < 4 || segments[count - 4] !== PLUGIN_ROOT) {
    return null
  }
  if (!VERSION_PATTERN.test(segments[count - 1])) {
    return null
  }
  const rootPath = segments.slice(0, count - 4).join('/')
  return {
    pluginDir: target.origin + '/' + segments.slice(0, count - 1).join('/') + '/',
    root: target.origin + (rootPath === '' ? '/' : '/' + rootPath + '/'),
    author: segments[count - 3],
  }
}

/** 版本目录地址；版本号不是三段数字时返回 null */
export const versionDirOf = (location: InstalledLocation, version: string): string | null =>
  VERSION_PATTERN.test(version) ? joinUrl(location.pluginDir, version + '/') : null

/** versions.json 地址；在插件目录这一级，即版本目录的上一级 */
export const versionsUrlOf = (location: InstalledLocation): string =>
  joinUrl(location.pluginDir, 'versions.json')

/** 比较三段版本号；左侧小返回负数，相等返回 0，任一侧非法返回 null */
export const compareVersions = (left: string, right: string): number | null => {
  const leftMatch = VERSION_PATTERN.exec(left)
  const rightMatch = VERSION_PATTERN.exec(right)
  if (!leftMatch || !rightMatch) {
    return null
  }
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(leftMatch[index]) - Number(rightMatch[index])
    if (delta !== 0) {
      return delta
    }
  }
  return 0
}

/** 更新判定：本地落后为 outdated，相同或更高为 latest，无法判断为 null */
export const updateStatusOf = (installed: string, latest: string): UpdateCheck['status'] | null => {
  const delta = compareVersions(installed, latest)
  if (delta === null) {
    return null
  }
  return delta < 0 ? 'outdated' : 'latest'
}

/** 记录里登记的数据基址；旧记录没有该字段时返回 null */
export const readRecordDataBase = (record: { id: string; dataBase?: unknown }): string | null =>
  typeof record.dataBase === 'string' && record.dataBase.trim() !== '' ? record.dataBase.trim() : null

/** 更新检查目标的数据基址：优先记录里的 dataBase，缺失时由 source_url 推导 */
export const dataBaseOf = (target: UpdateTarget): string | null => {
  if (target.dataBase) {
    return target.dataBase
  }
  return target.sourceUrl ? deriveDataBase(target.sourceUrl) : null
}

/** 重新安装所需的材料地址；全部由来源地址推导 */
export type ReinstallPaths = {
  url: string
  sigUrl: string
  authorSigUrl: string
  authorPubUrl: string
}

/** 按插件目录与目标版本拼出重新安装的材料地址 */
export const reinstallPathsOf = (
  location: InstalledLocation,
  version: string
): ReinstallPaths | null => {
  const versionDir = versionDirOf(location, version)
  if (!versionDir) {
    return null
  }
  return {
    url: joinUrl(versionDir, PLUGIN_FILE),
    sigUrl: joinUrl(versionDir, PLUGIN_FILE + '.sig'),
    authorSigUrl: joinUrl(versionDir, PLUGIN_FILE + '.author.sig'),
    authorPubUrl: joinUrl(location.root, PLUGIN_ROOT + '/' + location.author + '/author_pub.pem'),
  }
}
