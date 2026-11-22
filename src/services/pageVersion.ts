import { create } from 'zustand'
import { APP_NAME } from '../brand.js'

/*
 * 页面版本继承：构建时把版本注进 index.html 的 meta 标签，发布流水线在站点根下留存历史版本目录。
 * 页面加载后执行一次，当前实际加载的版本与上次使用的版本不一致时提示用户二选一，并把结论写回储存。
 */

/** 构建时注入页面版本的 meta 标签名，取值形如 dsc-1.0.0 */
const VERSION_META = 'application-version'
/** 历史版本目录的 tag 前缀；package.json 的版本号不带前缀，统一补成 tag 后再比较 */
const VERSION_TAG_PREFIX = 'dsc-'
/** 上次使用的页面版本 */
const LAST_KEY = `${APP_NAME}:page-version`
/** 已处理过的「当前版本 + 记录版本」组合，同一组合只提示一次 */
const ACK_KEY = `${APP_NAME}:page-version-ack`
/** 已点过「刷新到最新版」的临时标记；下次加载直接采纳加载到的版本，避免刷新后又提示一次 */
const REFRESH_KEY = `${APP_NAME}:page-version-refreshing`
/** 版本 tag 的取值规则，与发布流水线的 tag 校验保持一致 */
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]*$/
/** 待处理的版本不一致；pending 非空时界面显示提示 */
export type PageVersionPending = {
  /** 当前实际加载的页面版本 */
  current: string
  /** 上次使用的页面版本 */
  previous: string
  /** 旧版本页面的地址 */
  previousUrl: string
}

type PageVersionState = { pending: PageVersionPending | null }

export const usePageVersion = create<PageVersionState>(() => ({ pending: null }))

/** 是否已经执行过一次状态继承，避免重复提示 */
let inherited = false

const readStored = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const writeStored = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 储存不可用时只在本次会话内生效，不放行提示以外的任何行为
  }
}

/** 刷新标记放会话储存：只在当前标签页的一次刷新内有效 */
const sessionMark = (): string | null => {
  try {
    return sessionStorage.getItem(REFRESH_KEY)
  } catch {
    return null
  }
}

const setSessionMark = (): void => {
  try {
    sessionStorage.setItem(REFRESH_KEY, '1')
  } catch {
    // 会话储存不可用时退化为只比较版本，最多多提示一次
  }
}

const clearSessionMark = (): void => {
  try {
    sessionStorage.removeItem(REFRESH_KEY)
  } catch {
    // 同上
  }
}

/** 把版本号统一成发布 tag；已经是 tag 时原样返回，空值或非法内容返回 null */
export const versionTag = (value: string | null | undefined): string | null => {
  const text = (value ?? '').trim()
  if (text === '') {
    return null
  }
  const tag = text.startsWith(VERSION_TAG_PREFIX) ? text : `${VERSION_TAG_PREFIX}${text}`
  return VERSION_PATTERN.test(tag) ? tag : null
}

/** 读取当前实际加载的页面版本；meta 缺失或内容不是版本 tag 时返回 null */
export const readPageVersion = (): string | null => {
  const meta = document.querySelector<HTMLMetaElement>(`meta[name="${VERSION_META}"]`)
  return versionTag(meta?.content)
}

/** 页面所在目录；去掉末尾的文件名、查询串与锚点 */
const pageDirectory = (href: string): URL => {
  const url = new URL(href)
  if (!url.pathname.endsWith('/')) {
    const slash = url.pathname.lastIndexOf('/')
    url.pathname = slash === -1 ? '/' : url.pathname.slice(0, slash + 1)
  }
  url.search = ''
  url.hash = ''
  return url
}

/** 站点根地址；部署在子路径下时保留子路径，当前页面已在 <站点根>/<tag>/ 快照目录里时先去掉该目录 */
export const siteRootHref = (
  href: string = document.baseURI,
  tag: string | null = readPageVersion()
): string => {
  const url = pageDirectory(href)
  // 页面目录的末段与当前加载版本的 tag 一致即视为本版快照目录，直接剥掉；tag 未知时保持目录不变
  const dir = url.pathname.slice(0, -1)
  const slash = dir.lastIndexOf('/')
  if (tag !== null && dir.slice(slash + 1) === tag) {
    url.pathname = slash <= 0 ? '/' : dir.slice(0, slash + 1)
  }
  return url.href
}

/** 历史版本页面地址：<站点根>/<tag>/，部署包已扁平化，不再有 version/ 这一层 */
export const versionPageHref = (version: string, href: string = document.baseURI): string =>
  `${siteRootHref(href)}${encodeURIComponent(version)}/`

/** 最新版页面地址：站点根目录，附加一次性查询串绕开可能被缓存的 index.html */
export const latestPageHref = (
  href: string = document.baseURI,
  stamp: number = Date.now()
): string => `${siteRootHref(href)}?v=${stamp}`

const ackValue = (current: string, previous: string): string => `${current}|${previous}`

/** 页面加载后执行一次状态继承；返回是否显示了提示 */
export const runPageVersionInherit = (): boolean => {
  if (inherited) {
    return usePageVersion.getState().pending !== null
  }
  inherited = true
  const current = readPageVersion()
  if (current === null) {
    return false
  }
  // 刚点过「刷新到最新版」：直接采纳刷新后加载到的版本，不再提示
  if (sessionMark() !== null) {
    clearSessionMark()
    writeStored(LAST_KEY, current)
    return false
  }
  const previous = versionTag(readStored(LAST_KEY))
  // 首次访问：没有记录时不提示，只写入当前版本
  if (previous === null) {
    writeStored(LAST_KEY, current)
    return false
  }
  // 版本一致：记录跟随当前版本，不提示
  if (previous === current) {
    writeStored(LAST_KEY, current)
    return false
  }
  // 同一组合只提示一次：用户选择过或忽略过都不再打扰
  if (readStored(ACK_KEY) === ackValue(current, previous)) {
    return false
  }
  usePageVersion.setState({
    pending: { current, previous, previousUrl: versionPageHref(previous) },
  })
  return true
}

/** 刷新缓存到最新版页面：先留下刷新标记，再重新拉取站点根页面，记录在下次加载时更新 */
export const refreshToLatestPage = (): void => {
  if (usePageVersion.getState().pending === null) {
    return
  }
  usePageVersion.setState({ pending: null })
  setSessionMark()
  window.location.replace(latestPageHref())
}

/** 跳转到上次使用的旧版本页面 */
export const openPreviousVersionPage = (): void => {
  const { pending } = usePageVersion.getState()
  if (pending === null) {
    return
  }
  usePageVersion.setState({ pending: null })
  writeStored(LAST_KEY, pending.previous)
  writeStored(ACK_KEY, ackValue(pending.current, pending.previous))
  window.location.replace(pending.previousUrl)
}

/** 稍后处理：本次不跳转，只记下已提示过的组合，记录版本保持不动 */
export const dismissPageVersionNotice = (): void => {
  const { pending } = usePageVersion.getState()
  if (pending === null) {
    return
  }
  usePageVersion.setState({ pending: null })
  writeStored(ACK_KEY, ackValue(pending.current, pending.previous))
}
