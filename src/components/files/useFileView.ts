import { useEffect, useMemo, useState } from 'react'
import { getFileViewType } from '../../services/attachments.js'
import { loadFile } from '../../services/chat/db.js'

/** 链接属性：PDF 与非 SVG 图片在新标签打开，其余按下载处理 */
export type FileViewLink = {
  href: string
  target?: '_blank'
  rel?: 'noreferrer'
  download?: string
}

export type FileView = {
  /** 原件地址；加载中或原件缺失时为 null */
  url: string | null
  /** 展示类型是否为图片（含 SVG） */
  image: boolean
  /** 打开或下载原件的链接属性；没有地址时为 null */
  link: FileViewLink | null
}

const SVG_TYPE = 'image/svg+xml'

/** 按展示类型重切 Blob：未知后缀统一当作二进制流，不沿用浏览器给出的类型 */
const toViewBlob = (blob: Blob, viewType: string) =>
  new Blob([blob], { type: viewType || 'application/octet-stream' })

/** SVG 改为 base64 的 data 地址：与应用页面不同源，其中的脚本读不到本应用的存储 */
const toSvgDataUrl = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return `data:${SVG_TYPE};base64,${btoa(binary)}`
}

/** 生成展示地址：SVG 为 data 地址，其余为 blob 地址 */
export const createViewUrl = async (source: Blob, viewType: string) => {
  const blob = toViewBlob(source, viewType)
  return viewType === SVG_TYPE ? toSvgDataUrl(blob) : URL.createObjectURL(blob)
}

/** 统一释放入口：只释放 blob 地址，data 地址由浏览器自行回收 */
export const revokeViewUrl = (url: string | null) => {
  if (url?.startsWith('blob:')) {
    URL.revokeObjectURL(url)
  }
}

/** 链接规则：PDF 与非 SVG 图片新标签打开并带 noreferrer，其余以下载方式交出原件 */
export const getFileViewLink = (name: string, url: string): FileViewLink => {
  const viewType = getFileViewType(name)
  if (viewType === 'application/pdf' || (viewType.startsWith('image/') && viewType !== SVG_TYPE)) {
    return { href: url, target: '_blank', rel: 'noreferrer' }
  }
  return { href: url, download: name }
}

/** 草稿传本地 File，已发送附件传 IndexedDB 里的原件 ID */
const readOriginal = (source: File | string): Promise<Blob | undefined> =>
  typeof source === 'string' ? loadFile(source) : Promise.resolve(source)

/**
 * 附件原件的展示状态：按后缀得到展示类型，取回原件后重切 Blob 再生成地址。
 * 切换来源与卸载时统一释放上一次的 blob 地址。
 */
export const useFileView = (
  source: File | string | null | undefined,
  name: string
): FileView => {
  const viewType = getFileViewType(name)
  const [resolved, setResolved] = useState<{ source: File | string; url: string } | null>(null)

  useEffect(() => {
    if (!source) {
      return
    }
    let current: string | null = null
    let cancelled = false
    void readOriginal(source)
      .then(async (blob) => {
        if (!blob || cancelled) {
          return
        }
        const url = await createViewUrl(blob, viewType)
        if (cancelled) {
          revokeViewUrl(url)
          return
        }
        current = url
        setResolved({ source, url })
      })
      .catch(() => {})
    return () => {
      cancelled = true
      revokeViewUrl(current)
    }
  }, [source, viewType])

  const url = resolved && resolved.source === source ? resolved.url : null
  const link = useMemo(() => (url ? getFileViewLink(name, url) : null), [url, name])
  return { url, image: viewType.startsWith('image/'), link }
}
