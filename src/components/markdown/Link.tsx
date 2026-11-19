import type { Image, Link as LinkNode } from 'mdast'
import { memo, type ReactNode } from 'react'
import { isWebUrl } from '../../utils/url.js'

/**
 * 地址归一：协议缺省的地址补 https，协议判定交给 isWebUrl。
 * 页内锚点与 mailto 属于文字展示规则，由 Link 组件先行分流，不走本函数。
 */
const sanitizeUrl = (url: string) => {
  // 无协议的地址（如 example.com/a）按 https 补全；相对路径补全后仍由 isWebUrl 拒绝
  const candidate =
    url && !url.match(/^[a-zA-Z]+:\/\//) && !url.startsWith('mailto:') ? `https://${url}` : url
  return isWebUrl(candidate) ? new URL(candidate).toString() : undefined
}

export const Link = memo(function Link({
  node,
  children,
}: {
  node: LinkNode
  children: ReactNode
}) {
  // 页内锚点显示链接文字。
  if (node.url.startsWith('#')) {
    return children
  }

  // 邮件地址显示链接文字。
  if (node.url.startsWith('mailto:')) {
    return children
  }

  // 协议不合法时 href 为空，链接文字仍可显示。
  const href = sanitizeUrl(node.url)

  return (
    <a href={href} title={node.title || undefined} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
})

/** Markdown 图片显示为指向图片地址的链接 */
export function ImageAsLink({ node }: { node: Image }) {
  const url = sanitizeUrl(node.url)
  return (
    <a href={url} title={node.title ?? ''} target="_blank" rel="noreferrer">
      {url}
    </a>
  )
}
