declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {}

/** 公开 API 的地址，见 rspack.config.ts 的 createConfig */
declare const __API_ORIGIN__: string

/** 网页签名校验用的根证书（PEM），构建时从 certs/dsce/root-ca/dsce-root-ca.crt 注入；为空串时运行时不校验 */
declare const __ROOT_CA_PEM__: string

/** 网页签名校验用的 EEC 证书（PEM），构建时从 certs/dsce/dsce-pages/dsce-pages-eec.crt 注入，离线时用它验签 */
declare const __PAGES_EEC_PEM__: string

/** Prism 语言包通过副作用注册到全局 Prism */
declare module 'prismjs/components/*' {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module 'katex/contrib/mhchem' {}
