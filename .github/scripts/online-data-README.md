# online-data

DeepSeek-Chat-Enhanced 的信任数据分支,由发布流程生成,请勿手工修改。

## 目录结构

```
online-data/
├── README.md    # 本说明
├── index.json   # 信任清单
├── certs/       # 证书目录,结构与主仓库的 certs/ 一致
└── version/     # 按发布 tag 归档的副本
    ├── latest/  # 最近一次发布的内容
    └── <tag>/   # 每次发布的内容快照
```

`version/latest/` 与 `version/<发布 tag>/` 的内容与分支根目录完全一致,可按固定路径长期取用某一版信任数据。

## 当前发布

- 发布 tag: `{{TAG}}`
- 已归档版本:

{{VERSIONS}}

## 信任清单

`index.json` 的结构:

```json
{
  "schemaVersion": 2,
  "rootCa": "certs/ds-chat/ds-chat-root-ca.crt",
  "crl": null,
  "collections": [
    { "id": "<合集名>", "eec": "certs/<合集名>/<合集名>-eec.crt" }
  ]
}
```

本次登记的合集:

{{COLLECTIONS}}

`dsc-inner-plugin` 不登记进 `collections`: 它不是普通合集,其 EEC 随 `certs/dsc-inner-plugin/` 一起分发。

## 证书

| 证书 | 路径 |
|:---:|:---:|
| 根证书 | `certs/ds-chat/ds-chat-root-ca.crt` |
| 网页签名 EEC | `certs/ds-chat-pages/ds-chat-pages-eec.crt` |
| 内部插件 EEC | `certs/dsc-inner-plugin/dsc-inner-plugin-eec.crt` |
| 合集 EEC | `certs/<合集名>/<合集名>-eec.crt` |

## 校验口径

本分支的信任数据不做整体签名: 消费方的校验口径是「内嵌根证书 + 逐张 EEC 的证书链」,不存在校验整棵目录树签名的消费方。发布流程的说明见主仓库 `.github/workflows/pages.yml` 的注释。
