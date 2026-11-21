# trusted-manifest

DeepSeek-Chat-Enhanced 的信任清单归档分支,与 `main` 无公共祖先,由发布流水线写入,请勿手工修改。

## 职责

| 项目 | 说明 |
|:---:|:---|
| 放什么 | 信任清单 `index.json` 及其派生数据:根证书指向、各合集 EEC 的相对路径、吊销列表登记 |
| 不放什么 | 证书本体(在 `certs` 分支)、源码、私钥 |
| 谁写 | `.github/workflows/pages.yml` 的发布流程,清单由 `.github/scripts/build-trust-index.mjs` 依据主仓库 `certs/manifest.json` 生成 |
| 谁读 | 网页与插件引擎在启动时读取可信来源;发布流程在最后阶段把本分支内容并入页面包 |

## 目录结构

```
trusted-manifest/
├── README.md    # 本说明,发布流程会按模板重写
├── index.json   # 信任清单
└── version/
    ├── latest/  # 最近一次发布的内容
    └── <发布 tag>/ # 每次发布的内容快照,只保留最近 1000 个
```

## 清单结构

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

清单里的路径相对 `certs` 分支与合并后的页面包根目录,证书本体不在本分支。

## 归档 tag

本分支上的归档 tag 为「发行 tag + `-trusted-manifest`」,例如 `dsc-1.0.0-trusted-manifest`;后缀与分支名一致。

## 相关内容

- 发布产物归档分支: `dist-history`
- 证书与公钥归档分支: `certs`
- 三条并行分支的命名与职责见组织规范 `repo-spec/side-branches.md`
