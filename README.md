# dist-history

DeepSeek-Chat-Enhanced 的发布产物归档分支,与 `main` 无公共祖先,由发布流水线写入,请勿手工修改。

## 职责

| 项目 | 说明 |
|:---:|:---|
| 放什么 | 每次发布的网页产物副本,按发布 tag 分目录留存 |
| 不放什么 | 源码、构建脚本、依赖清单、私钥 |
| 谁写 | `.github/workflows/pages.yml` 的发布流程 |
| 谁读 | 需要回退到旧版页面的用户;发布流程在最后阶段把本分支内容并入页面包 |

## 目录结构

```
dist-history/
├── README.md      # 本说明
├── <产物文件>     # 最近一次发布的产物,与 version/latest 一致
└── version/
    ├── latest/    # 最近一次发布的产物
    └── <发布 tag>/ # 每次发布的产物快照,只保留最近 1000 个
```

分支根目录、`version/latest/` 与 `version/<发布 tag>/` 三份内容完全一致。

## 归档 tag

本分支上的归档 tag 为「发行 tag + `-dist-history`」,例如 `dsc-1.0.0-dist-history`;后缀与分支名保持一致。

## 相关内容

- 证书与公钥归档分支: `certs`
- 信任清单归档分支: `trusted-manifest`
- 三条并行分支的命名与职责见组织规范 `repo-spec/side-branches.md`
