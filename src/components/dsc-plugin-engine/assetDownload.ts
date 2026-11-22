import { isHttpsOrLocalUrl } from '../../utils/url.js'
import { sha512Hex } from '../../services/integrity/manifest.js'

/**
 * assets:download 的清单与取件实现。
 * 语义与失败码闭集见仓库规范 .github/docs/repo-spec/asset-download-capability.md:
 * 地址与哈希都来自插件清单, 引擎只按资产标识取件; 校验通过才交付字节, 引擎不落盘。
 * 请求形态与 assets:read 对齐: GET, 不带 Cookie 与自定义请求头, https 任意主机、回环主机允许 http。
 */

/** SHA-512 摘要的写法: 128 位小写十六进制, 与资产市场逐文件比对的清单登记一致 */
const SHA512_PATTERN = /^[0-9a-f]{128}$/

/** 资产标识规则: 插件内唯一, 小写字母开头, 只含小写字母、数字与连字符 */
const ASSET_ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** 资产版本规则: 严格三段数字, 与清单 version 同一形状 */
const ASSET_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/**
 * assets:download 的限流数值, 与 assets:read 的窗口分开计数。
 * 规范 4.5 未定, 这里先取保守默认值: 大体积传输次数少而流量大, 传输次数上限取得比读取紧,
 * 总流量按窗口累计, 覆盖一次数百 MB 的完整传输后仍留少量余量。
 * 数值等第一个真实消费者出现后按实测调整, 只改这一处常量。
 */
export const ASSET_DOWNLOAD_LIMIT = {
  /** 窗口内的传输次数上限 */
  transfers: 3,
  /** 窗口内累计传输的总字节数上限 */
  totalBytes: 512 * 1024 * 1024,
  /** 限流窗口宽度(毫秒) */
  windowMs: 10000,
}

/**
 * 总流量的窗口上限; 与传输次数同窗累计, 单独一个常量便于按实测只调一处。
 */
export const ASSET_DOWNLOAD_TOTAL_BYTES = ASSET_DOWNLOAD_LIMIT.totalBytes

/** 卡片进度的上报步长(字节); 步长内的中间值不上报, 收起前不补发 */
export const ASSET_DOWNLOAD_PROGRESS_STEP = 1024 * 1024

/** 清单里的一份资产声明; 形状与规范 3.2 一致, 全部由合集签名覆盖 */
export type PluginAsset = {
  /** 资产标识; 插件内唯一, 调用时用它指定资产 */
  id: string
  /** 绝对地址; 只允许 https, 回环主机允许 http */
  url: string
  /** SHA-512 摘要, 128 位小写十六进制 */
  sha512: string
  /** 声明体积(字节); 实际字节数与它不符即失败 */
  bytes: number
  /** 三段数字版本; 同一 id 换版本必须换地址或换哈希 */
  version: string
}

/**
 * 校验清单 assets 块的一条声明; 合格返回收敛后的声明, 不合格返回 null。
 * 字段全部必填: id 形态、url 绝对地址且协议合规(内嵌凭证直接拒绝)、sha512 形态、
 * bytes 正整数、version 三段数字。
 */
export const parseAssetEntry = (value: unknown): PluginAsset | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || !ASSET_ID_PATTERN.test(raw.id)) {
    return null
  }
  if (typeof raw.url !== 'string') {
    return null
  }
  let target: URL
  try {
    target = new URL(raw.url)
  } catch {
    return null
  }
  if (target.username !== '' || target.password !== '' || !isHttpsOrLocalUrl(target.href)) {
    return null
  }
  if (typeof raw.sha512 !== 'string' || !SHA512_PATTERN.test(raw.sha512)) {
    return null
  }
  if (typeof raw.bytes !== 'number' || !Number.isInteger(raw.bytes) || raw.bytes <= 0) {
    return null
  }
  if (typeof raw.version !== 'string' || !ASSET_VERSION_PATTERN.test(raw.version)) {
    return null
  }
  return { id: raw.id, url: target.href, sha512: raw.sha512, bytes: raw.bytes, version: raw.version }
}

/** assets:download 的失败码闭集, 见规范 3.3 */
export type AssetDownloadReason =
  | 'protocol'
  | 'status'
  | 'timeout'
  | 'too-large'
  | 'hash-mismatch'
  | 'aborted'

/** 资产下载失败; reason 是闭集内的失败码, detail 只写插件日志, 不回传协议细节 */
export class PluginAssetDownloadError extends Error {
  constructor(readonly reason: AssetDownloadReason, detail: string) {
    super('dsc-plugin-engine: assets:download failed (' + reason + '): ' + detail)
    this.name = 'PluginAssetDownloadError'
  }
}

/** 下载进度; 引擎用同一份数据驱动悬浮卡片与气泡通知, 插件侧不接触进度 */
export type AssetDownloadProgress = {
  pluginId: string
  pluginName: string
  assetId: string
  url: string
  declaredBytes: number
  receivedBytes: number
}

/** 悬浮卡片出口; 同一插件同一时刻只显示一张卡片, 多资产复用 */
export type DownloadCardSink = {
  /** 传输开始时回调, 引擎据此发气泡并铺卡片 */
  onStart: (progress: AssetDownloadProgress) => void
  /** 每次收到字节后回调, 卡片据它更新已收字节 */
  onProgress: (progress: AssetDownloadProgress) => void
  /** 传输结束(成功或失败)后收起该插件的卡片 */
  onSettled: (pluginId: string) => void
}

/**
 * 单次下载: GET, 不带 Cookie 与自定义请求头(credentials: 'omit'), 只接受清单里的地址。
 * 重定向跟随, 跳转后的最终地址按同一协议口径复核且不跨主机(规范 4.5 现状口径,
 * 跨主机 CDN 的现实需求出现前保持收紧); 命中失败码时已读内容随调用结束被丢弃。
 */
const requestAssetBytes = async (
  asset: PluginAsset,
  signal: AbortSignal,
  onChunk: (received: number) => void
): Promise<Uint8Array> => {
  if (signal.aborted) {
    throw new PluginAssetDownloadError('aborted', 'request was aborted before it started')
  }
  const target = new URL(asset.url)
  let response: Response
  try {
    response = await fetch(asset.url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'follow',
      cache: 'no-store',
      signal,
    })
  } catch (error) {
    if (signal.aborted) {
      throw new PluginAssetDownloadError('aborted', 'request was aborted')
    }
    throw new PluginAssetDownloadError(
      'status',
      error instanceof Error ? error.message : String(error)
    )
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throw new PluginAssetDownloadError('status', 'status ' + String(response.status))
  }
  const finalUrl = response.url === '' ? target.href : response.url
  if (!isHttpsOrLocalUrl(finalUrl)) {
    void response.body?.cancel().catch(() => undefined)
    throw new PluginAssetDownloadError('protocol', 'response came from a disallowed URL')
  }
  if (new URL(finalUrl).host !== target.host) {
    void response.body?.cancel().catch(() => undefined)
    throw new PluginAssetDownloadError('protocol', 'redirect crossed hosts')
  }
  return await readStreaming(response, asset, signal, onChunk)
}

/**
 * 读响应流: 边读边累计字节数, 超声明字节数立即中止并按 too-large 失败;
 * 摘要按累计后的完整缓冲终算, 与字节数一并按清单校验, 任一不符即失败, 已读内容整体丢弃。
 * 环境没有 WebCrypto 时按摘要不可用处理, 本次传输失败, 不交付未校验的字节。
 */
const readStreaming = async (
  response: Response,
  asset: PluginAsset,
  signal: AbortSignal,
  onChunk: (received: number) => void
): Promise<Uint8Array> => {
  const body = response.body
  if (!body) {
    // 没有流式响应体就只能整读, 体积校验与流式路径同一口径; 读体失败按取消或读取中断归类
    try {
      const buffer = new Uint8Array(await response.arrayBuffer())
      return await checkBytes(buffer, buffer.byteLength, asset)
    } catch (error) {
      if (signal.aborted) {
        throw new PluginAssetDownloadError('aborted', 'request was aborted while reading')
      }
      throw new PluginAssetDownloadError(
        'timeout',
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  const reader = body.getReader()
  // 累计缓冲只在读取期间存活, 校验失败或超限即整体丢弃; 摘要在读取结束后一次性终算
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      if (signal.aborted) {
        throw new PluginAssetDownloadError('aborted', 'request was aborted while reading')
      }
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }
      total += chunk.value.byteLength
      if (total > asset.bytes) {
        throw new PluginAssetDownloadError('too-large', 'body exceeds declared bytes')
      }
      chunks.push(chunk.value)
      onChunk(total)
    }
  } catch (error) {
    if (error instanceof PluginAssetDownloadError) {
      throw error
    }
    if (signal.aborted) {
      throw new PluginAssetDownloadError('aborted', 'request was aborted while reading')
    }
    throw new PluginAssetDownloadError(
      'timeout',
      error instanceof Error ? error.message : String(error)
    )
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return await checkBytes(merged, total, asset)
}

/** 摘要与字节数的最终校验; 任一不符即失败, 已读内容随抛错被丢弃 */
const checkBytes = async (
  bytes: Uint8Array,
  total: number,
  asset: PluginAsset
): Promise<Uint8Array> => {
  const digest = await sha512Hex(bytes)
  if (digest === null) {
    throw new PluginAssetDownloadError('hash-mismatch', 'digest unavailable')
  }
  if (digest !== asset.sha512 || total !== asset.bytes) {
    throw new PluginAssetDownloadError('hash-mismatch', 'digest or bytes mismatch')
  }
  return bytes
}

/**
 * 下载执行器。
 * 合并: 同一「插件 + 资产 id + sha512」的并发请求共用一次传输, 其余等待同一结果;
 * 失败同样合并, 等待者拿到同一个失败, 引擎不重试。
 * 取消: 用户点取消即中止底层请求, aborted 交给调用方; 被取消的合并键在传输结束前
 * 不再接受同一资产的合并等待, 后续调用重新发起传输。
 */
export const createAssetDownloader = (sink: DownloadCardSink) => {
  /** 活跃传输: 键是插件 id + 资产 id + sha512, 同键并发合并 */
  const runs = new Map<string, ActiveRun>()

  /** 一份活跃传输; 多个等待者共享同一个 Promise 与同一个中止器 */
  type ActiveRun = {
    bytes: Promise<Uint8Array>
    abort: AbortController
  }

  const keyOf = (pluginId: string, asset: PluginAsset): string =>
    pluginId + ' ' + asset.id + ' ' + asset.sha512

  /** 用户取消一个传输; 命中的活跃传输真正中止, 结束清理由共享结果统一完成 */
  const cancel = (pluginId: string, assetId: string): void => {
    for (const [key, run] of runs) {
      if (key.startsWith(pluginId + ' ' + assetId + ' ')) {
        run.abort.abort()
      }
    }
  }

  /** 取消一个插件的全部传输; 卸载清理用, 中止后等待者按 aborted 收尾 */
  const cancelAll = (pluginId: string): void => {
    for (const [key, run] of runs) {
      if (key.startsWith(pluginId + ' ')) {
        run.abort.abort()
      }
    }
  }

  const download = (
    pluginId: string,
    pluginName: string,
    asset: PluginAsset
  ): Promise<Uint8Array> => {
    const key = keyOf(pluginId, asset)
    const existing = runs.get(key)
    if (existing && !existing.abort.signal.aborted) {
      return existing.bytes
    }
    runs.delete(key)
    const abort = new AbortController()
    // 进度按步长上报: 大体积资产的小分片很密, 每片都刷卡片只会空转渲染;
    // 卡片不是进度条, 步长 1 MB 足够说明「已收多少」
    let reported = 0
    const progress = (receivedBytes: number): void => {
      if (receivedBytes - reported < ASSET_DOWNLOAD_PROGRESS_STEP) {
        return
      }
      reported = receivedBytes
      sink.onProgress({
        pluginId,
        pluginName,
        assetId: asset.id,
        url: asset.url,
        declaredBytes: asset.bytes,
        receivedBytes,
      })
    }
    // 先占位再填 Promise: 结束清理按「表里仍是这一份」判断, 被取消后同键立即重发的
    // 新传输不会被旧传输的清理误删; 卡片按插件复用, 只有该插件再无活跃传输时才收起
    const run: ActiveRun = { bytes: Promise.resolve(new Uint8Array(0)), abort }
    const started = (async () => {
      sink.onStart({
        pluginId,
        pluginName,
        assetId: asset.id,
        url: asset.url,
        declaredBytes: asset.bytes,
        receivedBytes: 0,
      })
      try {
        return await requestAssetBytes(asset, abort.signal, progress)
      } finally {
        if (runs.get(key) === run) {
          runs.delete(key)
        }
        let stillActive = false
        for (const activeKey of runs.keys()) {
          if (activeKey.startsWith(pluginId + ' ')) {
            stillActive = true
            break
          }
        }
        if (!stillActive) {
          sink.onSettled(pluginId)
        }
      }
    })()
    run.bytes = started
    runs.set(key, run)
    return started
  }

  return { download, cancel, cancelAll }
}
