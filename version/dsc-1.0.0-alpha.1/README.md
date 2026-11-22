# trusted-manifest

DeepSeek-Chat-Enhanced 的信任清单分支,与 `main` 无公共祖先,由发布流水线生成,请勿手工修改。

## 职责

本分支只放信任清单及其派生数据,不放证书本体:证书与公钥在 `certs` 分支,发布产物与历史版本在 `dist-history` 分支。

## 目录结构

```
trusted-manifest/
├── README.md    # 本说明
├── index.json   # 信任清单
└── version/     # 按发布 tag 归档的副本
    ├── latest/  # 最近一次发布的内容
    └── <tag>/   # 每次发布的内容快照
```

`version/latest/` 与 `version/<发布 tag>/` 的内容与分支根目录完全一致,可按固定路径长期取用某一版信任清单。

## 当前发布

- 发布 tag: `dsc-1.0.0-alpha.1`
- 已归档版本:

- `version/dsc-1.0.0-alpha.1/`

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

- `awesome-dsc-plugin`

`dsc-inner-plugin` 不登记进 `collections`: 它不是普通合集,其 EEC 随 `certs/dsc-inner-plugin/` 一起分发。

## 路径口径

清单里的 `rootCa`、`crl` 与各合集的 `eec` 都是相对路径,相对 `certs` 分支的根目录:

| 证书 | 清单登记路径 | 所在分支 |
|:---:|:---:|:---:|
| 根证书 | `certs/ds-chat/ds-chat-root-ca.crt` | `certs` |
| 网页签名 EEC | `certs/ds-chat-pages/ds-chat-pages-eec.crt` | `certs` |
| 内部插件 EEC | `certs/dsc-inner-plugin/dsc-inner-plugin-eec.crt` | `certs` |
| 合集 EEC | `certs/<合集名>/<合集名>-eec.crt` | `certs` |

发布流程在最后阶段把 `certs` 分支的 `certs/` 与本分支的 `index.json` 合并进同一个页面包,合并后同一份相对路径在站点根、`version/latest` 与 `version/<tag>` 内都成立。

## 归档 tag

本分支上的归档 tag 为「发行 tag + `-trusted-manifest`」,例如 `dsc-1.0.0-trusted-manifest`;后缀与分支名一致。

## 校验口径

本分支的信任清单不做整体签名: 消费方的校验口径是「内嵌根证书 + 逐张 EEC 的证书链」,不存在校验整棵目录树签名的消费方。发布流程的说明见主仓库 `.github/workflows/pages.yml` 的注释,分支职责与命名见 `docs/design/side-branches.md`。
