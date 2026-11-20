# 证书与云端 JSON 的 Schema 索引

`certs` 目录是公开证书与公钥的唯一来源,本目录存放约束这些 JSON 的 JSON Schema(draft 2020-12)。私钥不进入 `certs`,插件作者公钥属于各插件合集,也不在这里。

## Schema 一览

| Schema 文件 | 约束的 JSON | 所在分支与路径 | 对应代码模块 |
|:---:|:---:|:---:|:---:|
| `plugin-set-manifest.schema.json` | 插件合集证书登记清单 | `main` 分支 `certs/manifest.json` | 无运行时读取方;生成 online-data 的 `index.json` 时按它取合集 id 与 EEC 路径 |
| `trust-index.schema.json` | online-data 信任清单 | `online-data` 分支根目录 `index.json` | `src/services/trust/fetch.ts` 的 `parseTrustIndex`;`src/services/integrity/index.ts` 复用它取 `crl` |

## 路径约束

两份 Schema 都对路径给出同一条约束: 路径必须是相对路径,使用正斜杠,不得以 `/` 开头,不得带 URL 协议前缀,不得含两个点开头的目录穿越。

`certs/manifest.json` 里的 `eec` 相对 `certs` 目录,形式为 `<合集 id>/<合集 id>-eec.crt`。

`index.json` 里的 `rootCa`、`crl` 与各合集的 `eec` 相对 online-data 根目录。由于 CI 把 `certs` 目录原样放进 online-data 分支,这些路径形如 `certs/ds-chat/ds-chat-root-ca.crt`、`certs/<合集 id>/<合集 id>-eec.crt`;`index.json` 与 `crl.pem` 本身仍在 online-data 根目录。

## 校验方式

不引入新依赖,用任意支持 JSON Schema 2020-12 的实现加载即可;离线环境按 `required`、`pattern`、`const` 三个关键字做最小断言也够用。运行时侧不加载 Schema,路径合法性由 `parseTrustIndex` 与合集解析各自把关。

## 相关文档

- [信任链与 PKI 签名](../../docs/user/develop/basic/trust-chain.md)
- [网页签名与运行时校验](../../docs/user/develop/basic/web-signature.md)
