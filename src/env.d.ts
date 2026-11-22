declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {}

/** 公开 API 的地址，见 rspack.config.ts 的 createConfig */
declare const __API_ORIGIN__: string

/** 网页签名校验用的根证书（PEM），构建时从 certs/ds-chat/ds-chat-root-ca.crt 注入；为空串时运行时不校验 */
declare const __ROOT_CA_PEM__: string

/** 网页签名校验用的 EEC 证书（PEM），构建时从 certs/ds-chat-pages/ds-chat-pages-eec.crt 注入，离线时用它验签 */
declare const __PAGES_EEC_PEM__: string

/** 本地开发页面的地址，仅 dev 从 .env 的 DS_CHAT_PAGES_LINK 注入；production 为空串 */
declare const __DS_CHAT_PAGES_LINK__: string

/** 本地开发时 dsc-inner-plugin 来源的地址，仅 dev 从 .env 的 DSC_INNER_PLUGIN_PAGES_LINK 注入；为空串时用线上地址 */
declare const __DSC_INNER_PLUGIN_PAGES_LINK__: string

/** 本地开发时 awesome-dsc-plugin 来源的地址，仅 dev 从 .env 的 AWESOME_DSC_PLUGIN_PAGES_LINK 注入；为空串时用线上地址 */
declare const __AWESOME_DSC_PLUGIN_PAGES_LINK__: string

/** 是否为开发构建；dev 下不拉取线上信任材料与网页签名清单 */
declare const __DEV__: boolean

/** 本地开发时的证书镜像地址，仅 dev 从 .env 的 DS_CHAT_CERTS_LINK 注入；为空串且为 dev 时不请求任何镜像 */
declare const __DS_CHAT_CERTS_LINK__: string

/** 本地开发时的信任清单镜像地址，仅 dev 从 .env 的 DS_CHAT_TRUSTED_MANIFEST_LINK 注入；为空串且为 dev 时不请求任何镜像 */
declare const __DS_CHAT_TRUSTED_MANIFEST_LINK__: string

/** Prism 语言包通过副作用注册到全局 Prism */
declare module 'prismjs/components/*' {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module 'katex/contrib/mhchem' {}
