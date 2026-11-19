# 网页签名与运行时校验

本文说明网页产物如何用终端签名证书(EEC)做 CMS 分离签名,以及页面在运行时如何按证书链静默校验。内容与 `scripts/pki/ca.mjs`、`rspack.config.ts` 与 `src/services/` 下的证书校验模块一致,未实现的能力不写入本文。

## 机制概览

| 环节 | 位置 | 说明 |
|:---:|:---:|:---:|
| 签名 | `pnpm run pki -- sign-web` | 对每个 `.html`、`.js`、`.css` 生成 `<文件>.sig` |
| 清单 | `dist/web_files.json` | 按路径排序列出全部被签名文件,清单自身也有 `.sig` |
| 信任锚 | `rspack.config.ts` | 构建时把根证书 PEM 注入为 `__ROOT_CA_PEM__` |
| 信任数据分发 | online-data 分支 | 提供 `certs/dsce/root-ca/dsce-root-ca.crt` 与 `certs/dsce/dsce-pages/dsce-pages-eec.crt` |
| 运行时校验 | `src/services/integrity/` | 页面挂载后异步校验证书链与全部签名,失败只提示一条警告 |

## 签名范围

| 文件类型 | 是否签名 | 说明 |
|:---:|:---:|:---:|
| `.html` | 是 | 页面入口 |
| `.js` | 是 | 主包与异步分包 |
| `.css` | 是 | 主样式与异步样式 |
| 图片、字体 | 否 | 二进制资源 |
| `LICENSE`、`eec.pem` | 否 | 非代码文件与证书 |

`web_files.json` 只列出被逐文件签名的产物,清单自身不在其中,它的签名是 `web_files.json.sig` 。

## 证书与算法

| 项 | 约定 |
|:---:|:---:|
| 根 CA 密钥 | ECDSA P-256 |
| 根证书 | X.509 自签名,`keyUsage=critical,keyCertSign,cRLSign`,`basicConstraints=critical,CA:TRUE,pathlen:0`,有效期 3650 天 |
| EEC 密钥 | ECDSA P-256 |
| EEC 证书 | X.509 由根 CA 签发,`keyUsage=critical,digitalSignature`,`basicConstraints=critical,CA:FALSE`,有效期 365 天 |
| 签名格式 | CMS 分离签名,`openssl cms -sign -binary -outform DER -nocerts -noattr` |

根 CA 与 EEC 统一用 ECDSA P-256:浏览器 WebCrypto 对 P-256 支持最广,而证书链校验必须能在浏览器里完成。CMS 签名按文件原始字节计算,不做换行规范化;`-outform DER` 让签名文件是裸 DER,浏览器端可直接解析;`-nocerts` 让签名不带证书,证书由分发结构单独提供。

## 清单格式

```json
{
  "schemaVersion": 1,
  "files": ["index.html", "static/js/main.abcdef12.js"]
}
```

| 字段 | 说明 |
|:---:|:---:|
| `schemaVersion` | 固定为 1,结构变化时递增 |
| `files` | 相对 `dist` 根目录的路径,使用正斜杠,按路径排序 |

## 构建期签名

```
pnpm build
node scripts/pki/ca.mjs sign-web --dir dist --eec certs/dsce/dsce-pages/dsce-pages-eec.crt --key eec_secret.pem
```

`sign-web` 依次做四件事:遍历 `dist` 下全部 `.html`、`.js`、`.css` 生成 `<文件>.sig`;写出 `dist/web_files.json`;对清单生成 `web_files.json.sig`;把 EEC 证书复制为 `dist/eec.pem` 。签名只读取文件字节,不修改被签名的文件。

| 情形 | 行为 |
|:---:|:---:|
| `--dir` 不存在或不是目录 | 以非零退出码结束并给出提示 |
| 目录下没有可签名文件 | 以非零退出码结束,避免产出空清单 |
| EEC 证书与私钥不配对 | 以非零退出码结束,不做签名 |
| EEC 证书或私钥不存在 | 以非零退出码结束并指出缺失的文件 |

根 CA 与 EEC 的生成、签发方式见 [信任链与 PKI 签名](trust-chain.md) 。

## 构建时注入根证书

`rspack.config.ts` 通过 `DefinePlugin` 注入全局常量 `__ROOT_CA_PEM__` ,取值来自 `certs/dsce/root-ca/dsce-root-ca.crt` ;`createConfig` 的 `rootCaPem` 参数可以显式覆盖该默认值。

根证书必须内嵌: 离线运行拉不到任何在线副本,没有内嵌根证书就无法校验证书链,因此该文件缺失时构建失败,而不是产出无法校验的产物。

| 情形 | 行为 |
|:---:|:---:|
| 根证书文件存在且是 PEM | 注入根证书 PEM |
| 根证书文件缺失 | 构建失败并提示缺失的文件 |
| 文件存在但不是 PEM 证书 | 构建失败并提示不是 PEM 证书,避免把错误内容当成信任锚 |

## 运行时校验

页面挂载后调用 `verifyWebIntegrity()`,该校验异步执行,不阻塞渲染,且只执行一次。X.509 与 CMS 的解析交给 `pkijs` 与 `asn1js`,验签的密码学运算交给 WebCrypto,不自写 ASN.1 解析。校验模块按需动态加载,未注入根证书时不会进入首屏代码。

| 步骤 | 行为 |
|:---:|:---:|
| 根证书为空 | 直接返回,不发起任何请求 |
| 拉取 `certs/dsce/root-ca/dsce-root-ca.crt` | 按 online-data 的多镜像依次尝试,单个请求超时 1 秒;拉不到时只记一条提示,继续按内嵌根证书校验 |
| 核对信任锚 | 拉到的根证书必须与内嵌根证书逐字节一致,否则提示一条警告 |
| 拉取 `certs/dsce/dsce-pages/dsce-pages-eec.crt` | 同样走多镜像与 1 秒超时;拉不到时静默返回 |
| 校验证书链 | 签发者与主体匹配、EEC 的签名可用根证书公钥验证、两端都在有效期内、根证书为 CA、EEC 的 `keyUsage` 含 `digitalSignature`、EEC 不是 CA |
| 拉取 `web_files.json` | 相对页面地址请求;产物没有清单时静默返回 |
| 验证清单签名 | 用 EEC 校验 `web_files.json.sig` 的 CMS 分离签名 |
| 逐文件校验 | 并发上限 6,逐个拉取 `<文件>` 与 `<文件>.sig` 并验签 |
| 全部通过 | 完全静默 |
| 证书链或清单失败 | 提示一条警告,不继续逐文件校验 |
| 文件校验失败 | 汇总失败数量与前几个文件名,提示一条警告 |

失败不阻断服务、不重试、不弹窗:页面照常运行,提示内容说明产物与签名不一致,建议刷新或重新下载。多镜像与超时语义复用 `src/services/trust/` 的既有实现,不重复实现。

## 发布流水线

`.github/workflows/pages.yml` 直接构建,根证书由 `certs/dsce/root-ca/dsce-root-ca.crt` 内嵌,不再从 secrets 注入;在构建之后、上传产物之前执行 `sign-web`:

- `secrets.WEB_EEC_KEY` 写入仓库内被忽略的临时文件,签完立即删除;
- EEC 证书取 `certs/dsce/dsce-pages/dsce-pages-eec.crt` ;
- 执行 `node scripts/pki/ca.mjs sign-web --dir dist --eec <EEC> --key <私钥>` 。

密钥缺失时签名步骤直接失败并给出明确错误,避免发布未签名的产物。

## 换行符

签名基于文件字节,换行符变化会让签名失效。仓库统一 LF,`.gitattributes` 的第一条规则为 `* text=auto eol=lf` 。

## 排错

| 现象 | 常见原因 |
|:---:|:---:|
| 产物里 `__ROOT_CA_PEM__` 为空 | 只有 `createConfig` 显式传入空串才会这样;正常构建会从 `certs/dsce/root-ca/dsce-root-ca.crt` 注入 |
| 页面提示证书链校验未通过 | online-data 的 `certs/dsce/root-ca/dsce-root-ca.crt` 与内嵌根证书不一致,或 `certs/dsce/dsce-pages/dsce-pages-eec.crt` 不是该根证书签发的 |
| 页面提示签名校验未通过 | 产物在签名后被改动,或签名用的 EEC 与 `dist/eec.pem` 不是同一张证书 |
| 校验始终静默 | 产物没有 `web_files.json`,或根证书为空,或拉取 online-data 失败 |
| `sign-web` 报 EEC 证书与私钥不配对 | 传入了别的证书或私钥 |

## 相关文档

- [信任链与 PKI 签名](trust-chain.md)
