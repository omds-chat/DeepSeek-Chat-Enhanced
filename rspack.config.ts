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
const EMBEDDED_ROOT_CA_PATH = 'certs/dsce/root-ca/dsce-root-ca.crt'
const EMBEDDED_PAGES_EEC_PATH = 'certs/dsce/dsce-pages/dsce-pages-eec.crt'

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

type ConfigOptions = {
  /** 公开 API 的地址，注入为 __API_ORIGIN__ */
  apiOrigin?: string
  /** 开发服务器配置，支持本地接口代理 */
  devServer?: Configuration['devServer']
  /** 开发模式标记；缺省按 NODE_ENV 判断 */
  dev?: boolean
  /** 内嵌到产物的根证书 PEM，注入为 __ROOT_CA_PEM__；缺省读 certs/dsce/root-ca/dsce-root-ca.crt */
  rootCaPem?: string
  /** 内嵌到产物的网页签名 EEC 证书 PEM，注入为 __PAGES_EEC_PEM__；缺省读 certs/dsce/dsce-pages/dsce-pages-eec.crt */
  pagesEecPem?: string
}

/** 创建构建配置，支持自定义 API 地址和开发服务器选项 */
export const createConfig = ({
  apiOrigin = 'https://api.deepseek.com',
  devServer,
  dev = process.env.NODE_ENV !== 'production',
  rootCaPem = readRootCaPem(),
  pagesEecPem = readPagesEecPem(),
}: ConfigOptions = {}): Configuration => ({
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
    }),
    new rspack.CopyRspackPlugin({
      patterns: [{ from: path.resolve(root, 'LICENSE'), to: 'LICENSE', toType: 'file' }],
    }),
  ],
  performance: { hints: false },
  devServer: { port: 8090, ...devServer },
})

// eslint-disable-next-line import/no-default-export
export default defineConfig((_env, argv) =>
  createConfig({ dev: argv?.mode !== 'production' })
)
