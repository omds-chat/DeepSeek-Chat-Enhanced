import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspack/cli'
import { rspack, type Configuration } from '@rspack/core'

const targets = ['chrome >= 105', 'edge >= 105', 'safari >= 16', 'firefox >= 110']
const root = path.dirname(fileURLToPath(import.meta.url))
/** 版本 tag 前缀: 发布 tag 与页面版本统一为 dsc-<版本号> 形式 */
const VERSION_TAG_PREFIX = 'dsc-'

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string }

const cssLoader = {
  loader: 'builtin:lightningcss-loader',
  options: { targets },
}

/**
 * 内嵌到产物的材料路径，相对仓库根目录。
 * 离线运行拉不到在线副本，根证书与网页签名 EEC 都必须随构建内嵌，因此只认 certs 目录里的这两份。
 */
const EMBEDDED_ROOT_CA_PATH = 'certs/ds-chat/ds-chat-root-ca.crt'
const EMBEDDED_PAGES_EEC_PATH = 'certs/ds-chat-pages/ds-chat-pages-eec.crt'

/**
 * 读取内嵌 PEM 证书。
 * 文件缺失或不是 PEM 证书时直接让构建失败：产物缺少信任材料就无法做网页校验。
 */
const readPem = (relativePath: string, label: string): string => {
  const certPath = path.resolve(root, relativePath)
  let text: string
  try {
    text = readFileSync(certPath, 'utf8')
  } catch {
    throw new Error(
      '缺少内嵌' + label + ' ' + relativePath + '：离线运行无法拉取在线副本，该文件必须随仓库提供'
    )
  }
  if (!text.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('内嵌' + label + ' ' + relativePath + ' 不是 PEM 证书')
  }
  return text.trim() + '\n'
}

/** 内嵌根证书 PEM，网页校验的信任锚 */
const readRootCaPem = (): string => readPem(EMBEDDED_ROOT_CA_PATH, '根证书')

/** 内嵌网页签名 EEC 证书 PEM，离线时用它验证网页签名 */
const readPagesEecPem = (): string => readPem(EMBEDDED_PAGES_EEC_PATH, '网页签名 EEC 证书')

/** dev 时从仓库根 .env 读取的来源地址变量名，顺序即 .env 里的书写顺序 */
const DEV_LINK_KEYS = [
  'DS_CHAT_PAGES_LINK',
  'DSC_INNER_PLUGIN_PAGES_LINK',
  'AWESOME_DSC_PLUGIN_PAGES_LINK',
] as const

type DevLinkKey = (typeof DEV_LINK_KEYS)[number]

/** .env 提供的开发地址；未设置时为空串 */
type DevLinks = Record<DevLinkKey, string>

/** 未提供 DS_CHAT_PAGES_LINK 时的开发服务器端口，与本地回环主机一起构成默认地址 */
const DEFAULT_DEV_PORT = 8090
/** 未提供 DS_CHAT_PAGES_LINK 时的开发服务器主机，只监听回环地址 */
const DEFAULT_DEV_HOST = '127.0.0.1'

/**
 * 解析 .env 文本：跳过空行与 # 注释行，按首个 = 切分键值，支持成对引号包裹的值。
 * 只服务于本地开发的地址注入，不引入依赖。
 */
const parseEnvText = (text: string): Record<string, string> => {
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }
    const separator = trimmed.indexOf('=')
    if (separator <= 0) {
      continue
    }
    const key = trimmed.slice(0, separator).trim()
    const raw = trimmed.slice(separator + 1).trim()
    const quote = raw.charAt(0)
    const quoted = (quote === '"' || quote === "'") && raw.length >= 2 && raw.endsWith(quote)
    values[key] = quoted ? raw.slice(1, -1) : raw
  }
  return values
}

/**
 * 读取 .env 里的开发地址。
 * 只在 dev 读取：production 构建完全不碰 .env，产物里不会出现本地地址。
 * 文件缺失、解析失败或变量未设置时，三个变量都取空串。
 */
const readDevLinks = (dev: boolean, envPath: string | null): DevLinks => {
  const links: DevLinks = {
    DS_CHAT_PAGES_LINK: '',
    DSC_INNER_PLUGIN_PAGES_LINK: '',
    AWESOME_DSC_PLUGIN_PAGES_LINK: '',
  }
  if (!dev || envPath === null) {
    return links
  }
  let text: string
  try {
    text = readFileSync(envPath, 'utf8')
  } catch {
    return links
  }
  const values = parseEnvText(text)
  for (const key of DEV_LINK_KEYS) {
    links[key] = (values[key] ?? '').trim()
  }
  return links
}

/**
 * 由 DS_CHAT_PAGES_LINK 解析开发服务器的主机与端口，让 dev 页面与来源地址同址。
 * 未设置、协议不符或端口非法时回落到端口 8090 与回环地址。
 */
const resolveDevServerTarget = (pagesLink: string): { port: number; host: string } => {
  const fallback = { port: DEFAULT_DEV_PORT, host: DEFAULT_DEV_HOST }
  let target: URL
  try {
    target = new URL(pagesLink)
  } catch {
    return fallback
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return fallback
  }
  const port = target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fallback
  }
  // IPv6 主机在 URL 里带方括号，dev-server 的 host 选项要不带方括号的地址
  return { port, host: target.hostname.replace(/^\[(.+)\]$/, '$1') }
}

type ConfigOptions = {
  /** 公开 API 的地址，注入为 __API_ORIGIN__ */
  apiOrigin?: string
  /** 开发服务器配置，支持本地接口代理 */
  devServer?: Configuration['devServer']
  /** 开发模式标记；缺省按 NODE_ENV 判断 */
  dev?: boolean
  /** 内嵌到产物的根证书 PEM，注入为 __ROOT_CA_PEM__；缺省读 certs/ds-chat/ds-chat-root-ca.crt */
  rootCaPem?: string
  /** 内嵌到产物的网页签名 EEC 证书 PEM，注入为 __PAGES_EEC_PEM__；缺省读 certs/ds-chat-pages/ds-chat-pages-eec.crt */
  pagesEecPem?: string
  /** dev 读取的 .env 路径；缺省读仓库根 .env，传 null 表示不读 .env */
  envPath?: string | null
}

/** 创建构建配置，支持自定义 API 地址和开发服务器选项 */
export const createConfig = ({
  apiOrigin = 'https://api.deepseek.com',
  devServer,
  dev = process.env.NODE_ENV !== 'production',
  rootCaPem = readRootCaPem(),
  pagesEecPem = readPagesEecPem(),
  envPath = path.resolve(root, '.env'),
}: ConfigOptions = {}): Configuration => {
  // 开发地址只在 dev 读取 .env，production 构建不读，产物里不会出现本地地址
  const links = readDevLinks(dev, envPath)
  return {
    mode: dev ? 'development' : 'production',
    entry: './src/main.tsx',
    output: {
      path: path.resolve(root, 'dist'),
      // 运行时按当前脚本地址推导资源路径，file:// 下异步 chunk、字体都按相对位置加载
      publicPath: 'auto',
      filename: 'static/js/[name].[contenthash:8].js',
      chunkFilename: 'static/js/async/[name].[contenthash:8].js',
      cssFilename: 'static/css/[name].[contenthash:8].css',
      cssChunkFilename: 'static/css/async/[name].[contenthash:8].css',
      assetModuleFilename: 'static/media/[name].[contenthash:8][ext]',
      clean: true,
    },
    devtool: dev ? 'cheap-module-source-map' : false,
    // 开发模式预编译异步模块，保持首次加载代码高亮和公式时的页面状态
    lazyCompilation: false,
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
      // 将 .js 导入路径解析到同名 .ts、.tsx 或 .js 文件
      extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
    },
    module: {
      // CSS Modules 使用默认导出：`import styles from './x.module.css'`
      parser: { 'css/module': { namedExports: false } },
      generator: { 'css/module': { localIdentName: '[local]-[hash:6]' } },
      rules: [
        { test: /\.module\.css$/, type: 'css/module', use: [cssLoader] },
        { test: /\.css$/, exclude: /\.module\.css$/, type: 'css', use: [cssLoader] },
        {
          test: /\.(j|t)sx?$/,
          exclude: /[\\/]node_modules[\\/]/,
          loader: 'builtin:swc-loader',
          options: {
            jsc: {
              parser: { syntax: 'typescript', tsx: true },
              transform: { react: { runtime: 'automatic', development: dev } },
              externalHelpers: true,
            },
            env: { targets },
          },
          type: 'javascript/auto',
        },
        {
          // @noble/ed25519 同时提供 index.js 与 index.ts，extensionAlias 会优先命中 .ts
          test: /@noble[\\/]ed25519[\\/]index\.ts$/,
          loader: 'builtin:swc-loader',
          options: {
            jsc: { parser: { syntax: 'typescript' } },
            env: { targets },
          },
          type: 'javascript/auto',
        },
        { test: /\.(woff2?|ttf)$/, type: 'asset/resource' },
      ],
    },
    plugins: [
      // 经典 defer 脚本支持 file:// 页面的资源加载
      new rspack.HtmlRspackPlugin({
        template: './src/index.html',
        scriptLoading: 'defer',
        meta: { 'application-version': `${VERSION_TAG_PREFIX}${version}` },
      }),
      new rspack.DefinePlugin({
        __API_ORIGIN__: JSON.stringify(apiOrigin),
        // 网页签名校验用的根证书与 EEC 证书；根证书为空串时运行时不校验
        __ROOT_CA_PEM__: JSON.stringify(rootCaPem),
        __PAGES_EEC_PEM__: JSON.stringify(pagesEecPem),
        // 本地开发的来源地址，仅 dev 从 .env 注入，production 恒为空串
        __DS_CHAT_PAGES_LINK__: JSON.stringify(links.DS_CHAT_PAGES_LINK),
        __DSC_INNER_PLUGIN_PAGES_LINK__: JSON.stringify(links.DSC_INNER_PLUGIN_PAGES_LINK),
        __AWESOME_DSC_PLUGIN_PAGES_LINK__: JSON.stringify(links.AWESOME_DSC_PLUGIN_PAGES_LINK),
      }),
      new rspack.CopyRspackPlugin({
        patterns: [{ from: path.resolve(root, 'LICENSE'), to: 'LICENSE', toType: 'file' }],
      }),
    ],
    performance: { hints: false },
    // 开发服务器跟随 .env: 端口与主机由 DS_CHAT_PAGES_LINK 解析，未设置时回落到默认值
    devServer: { ...resolveDevServerTarget(links.DS_CHAT_PAGES_LINK), ...devServer },
  }
}

// eslint-disable-next-line import/no-default-export
export default defineConfig((_env, argv) => createConfig({ dev: argv?.mode !== 'production' }))
