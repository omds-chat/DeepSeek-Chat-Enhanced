# certs

DeepSeek-Chat-Enhanced 的可公开证书与公钥归档分支,与 `main` 无公共祖先,由发布流水线写入,请勿手工修改。

## 职责

| 项目 | 说明 |
|:---:|:---|
| 放什么 | 主仓库 `certs/` 目录的整体副本:根证书、各来源的终端签名证书(EEC)与其公钥 |
| 不放什么 | 任何私钥;插件作者公钥属于各合集自身,也不在此 |
| 谁写 | `.github/workflows/pages.yml` 的发布流程,整体复制并保留 `certs/` 前缀 |
| 谁读 | 网页与插件引擎在运行时取信任锚与验证材料;发布流程在最后阶段把本分支内容并入页面包 |

## 目录结构

```
certs/
├── README.md      # 本说明
├── certs/         # 证书目录,结构与主仓库的 certs/ 完全一致
└── version/
    ├── latest/    # 最近一次发布的内容
    └── <发布 tag>/ # 每次发布的内容快照,只保留最近 1000 个
```

分支内保留 `certs/` 这一层前缀,使信任清单里 `certs/ds-chat/ds-chat-root-ca.crt` 这类相对路径在本分支、`trusted-manifest` 分支与合并后的页面包中写法一致。

## 归档 tag

本分支上的归档 tag 为「发行 tag + `-certs`」,例如 `dsc-1.0.0-certs`;后缀与分支名保持一致。

## 相关内容

- 发布产物归档分支: `dist-history`
- 信任清单归档分支: `trusted-manifest`
- 三条并行分支的命名与职责见组织规范 `repo-spec/side-branches.md`
