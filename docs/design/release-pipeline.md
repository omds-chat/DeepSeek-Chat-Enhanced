# 发布流水线的双态行为

本文是本仓库发布流水线的行为总纲,把同一套流水线(`.github/workflows/pages.yml` 与 `.github/workflows/release-assets.yml`)在正式发行与预发行两种形态下的全部行为差异成文,行为逐条核对自工作流步骤脚本。正式发行的 tag 形如 `dsc-主版本.次版本.修订版本`(三段均为十进制数),预发行的 tag 在其后追加 `-XXX.序号`(`XXX` 为小写字母串,序号为十进制数)。冲突时以谁为准: 工作流脚本与 `.github/scripts/` 下脚本的实现 > 本文 > 其他文档;发现描述与脚本不一致时改本文。

分工: 并行分支(`dist-history`、`certs`、`trusted-manifest`)的职责、命名与归档落点见 [并行分支的命名与布局](side-branches.md);本文只管发布行为本身(触发校验、双态矩阵、站点结构、幂等、推送、留存、附件),两文互相链接,重复的双态行为以本文为准。

## tag 规范与触发对应性

两条工作流同构: 触发方式都是 `release` 的 `published` 事件,或手动 `workflow_dispatch` 传入 `tag`;发布 tag 都取 `release.tag_name` 或手动输入参数。

| 事项 | 口径 |
|:---:|:---:|
| 正式发行 tag | `dsc-主版本.次版本.修订版本`,三段均为十进制数,例如 `dsc-1.0.0` |
| 预发行 tag | 正式格式后追加 `-XXX.序号`,`XXX` 为小写字母串(不限定具体词表,保留 alpha、beta、rc 等扩展性),序号为十进制数,例如 `dsc-1.0.0-alpha.1` |
| 格式校验 | 两条工作流用同一个正则校验 tag 格式,不符直接中止,避免不合规的 tag 进入 version 目录并污染后续归档(pages.yml「Validate release tag format」步、release-assets.yml「Validate tag and release kind」步) |
| release 事件对应性 | tag 后缀判出的发行类型必须与 Release 的预发行标记一致,不一致拒绝执行(两条工作流同一条口径) |
| 手动触发 | 按 tag 后缀判定发行类型,不读 Release 标记;附件流程额外要求该 tag 的 Release 已存在,否则拒绝补传 |
| tag 存在性 | 主工作区检出该 tag,tag 不存在时检出步即失败;pages.yml 另有显式的 tag 存在性与 HEAD 对位校验 |

## 双态行为矩阵

| 行为 | 正式发行 | 预发行 | 脚本依据 |
|:---:|:---:|:---:|:---:|
| 站点根页面 | 本轮构建产物顶上站点根 | 绝不进站点根: 站点根整体取最近发行版的内容(即 `dist-history` 分支根);从未有发行版时不拷贝任何页面内容,没有兜底 | pages.yml「Assemble Pages directory」步 |
| 站点根信任材料 | 用本轮内容,与归档分支根目录一致 | 信任材料始终提供: 取最近发行版的;从未有发行版时取本版生成的;`certs/` 或 `index.json` 缺一即中止 | pages.yml「Assemble Pages directory」步 |
| `dist-history` 归档形态 | 清理工作树后重建,分支根目录、`version/latest`、`version/<tag>` 三份一致 | 不清理,只新增 `version/<tag>/` 存本版产物 | pages.yml「Publish dist-history branch」步 |
| `certs` 归档形态 | 清理工作树后重建,根目录 `certs/`、`version/latest/certs`、`version/<tag>/certs` 三份一致 | 不清理,只新增 `version/<tag>/certs/` 存本版证书副本 | pages.yml「Publish certs branch」步 |
| `trusted-manifest` 归档形态 | 清理工作树后重建,根目录、`version/latest`、`version/<tag>` 三份一致 | 不清理,只新增 `version/<tag>/` 存本版清单与说明 | pages.yml「Publish trusted-manifest branch」步 |
| `version/latest` | 重建为本版内容 | 不动,维持最近发行版 | 三个 Publish 步 |
| 发行附件 | `web-<tag>.zip` 上传到 Release | 口径与正式发行一致 | release-assets.yml「Package dist」「Upload to release」步 |

信任材料本体从哪来: `certs` 分支的内容只有主仓库 `certs/` 目录的整体复制(保留 `certs/` 前缀层,该步骤不生成、不签发、不替换任何证书);`trusted-manifest` 分支的 `index.json` 由 `.github/scripts/build-trust-index.mjs` 依据 `certs/manifest.json` 生成,登记 `certs/...` 相对路径而不是证书字节,保证相对路径在站点根与各版本入口内都成立。分支自身的职责与落点见 [并行分支的命名与布局](side-branches.md)。

## 站点结构与版本快照

组装目录放在 runner 临时区,不落在任何一个工作树内;页面包不保留 `version/` 这一层——三条归档分支各自 `version/` 下的内容全部释放到包根,每个版本成为站点根下的一个目录:

```text
页面包(站点根)
├── index.html              # 正式发行: 本轮构建;预发行: 最近发行版的(无发行史时不存在)
├── assets/                 # 随构建产物而来,来源同上
├── LICENSE                 # 随构建产物而来
├── certs/                  # 信任材料,始终存在: 正式发行与本版一致;预发行取最近发行版的
├── index.json              # 信任清单,口径同 certs/
├── latest/                 # 最近一次正式发行的完整快照,只在正式发行时更新
└── dsc-1.0.0-alpha.1/      # 每个归档 tag 一个版本目录,该版本的完整快照
    ├── index.html          # 本版页面入口
    ├── assets/             # 本版静态资源
    ├── LICENSE
    ├── certs/              # 本版证书副本,结构与站点根 certs/ 一致
    ├── index.json          # 本版信任清单
    └── README.md           # 本版清单说明
```

- `/<tag>/` 是该版本的完整快照: 构建产物 + `certs/` + `index.json` + `README.md`,访问 `/<tag>/` 即可取齐全套。
- `latest/` 指向最近一次正式发行;预发行不更新它。
- 同名文件的合并顺序是「产物 -> 证书 -> 清单」,清单分支的 `README.md` 最终生效;版本目录名用基础 tag,归档 tag 另加分支后缀,见 [并行分支的命名与布局](side-branches.md)。
- 组装后清掉混入的 `.git` 元数据,保证 git 元数据不进站点。

归档分支自身保留 `version/` 层,以 `dist-history` 为例,正式发行后的形态:

```text
dist-history 分支
├── README.md               # 归档仓库占位说明,清理白名单固定保留
├── index.html              # 分支根目录: 本轮构建产物
├── assets/                 # 分支根目录: 本轮构建产物
└── version/
    ├── latest/             # 本轮构建产物,与根目录一致
    └── dsc-1.0.0/          # 本轮构建产物,与根目录一致
```

预发行后只多一个 `version/<tag>/` 目录,根目录与 `version/latest/` 维持原样。`certs` 分支的三处都带 `certs/` 前缀层,`trusted-manifest` 分支的三处各是 `index.json` 与 `README.md` 两个文件。

## 重跑幂等

| 事项 | 口径 |
|:---:|:---:|
| 归档 tag | 每轮先删本地旧 tag 再重建,推送时用 `--force` 覆盖远端旧 tag;重复触发同一 tag 不产生新 tag 名 |
| `version/<tag>` | 一律先清后建,重跑不会叠加旧内容(三个 Publish 步同口径) |
| 仅签名不同 | `dist-history` 在重建前暂存旧目录,重建后按排除 `*.sig` 的全量 diff 比较,内容一致时还原旧目录,不产生噪音 commit(ECDSA 每次签名字节随机,签名字节差不是变更);`certs` 与 `trusted-manifest` 内容确定,无此判定,靠 commit 前的 `git diff --cached --quiet` 跳过空变更 |
| 分支推送 | 按快进前进,远端与本地分叉时推送失败,不强推覆盖分支历史 |

## push 末位

三个 Publish 步只在各自工作树里 commit 并打本地 tag,push 统一放在最后的「Push archive branches」步: 组装与上传全部成功后才依次推 `dist-history`、`certs`、`trusted-manifest` 三条分支与各自的归档 tag;此前任何一步失败,归档分支与远端 tag 零污染。归档 tag 用 `--force` 覆盖,分支按快进前进。

## 版本留存裁剪

裁剪由 `.github/scripts/prune-versions.mjs` 完成,三条归档分支各自在自己的 `version/` 上执行,口径一致:

| 事项 | 口径 |
|:---:|:---:|
| 保留上限 | 每分支 `version/` 保留最近 1000 个版本目录(`MAX_VERSIONS`);`latest` 不参与计数与排序,始终保留 |
| 排序口径 | 版本目录名解析成数值后按三段数值降序;三段相同时正式版排在预发行之前(同基础版本的正式发布晚于其预发行);两个预发行之间按 `XXX` 的 ASCII 降序、序号降序,ASCII 小、序号小的是更旧的预发行,裁剪时先被淘汰;全部相同时按目录名降序,保证排序稳定可复现 |
| 执行时机 | 裁剪在 commit 之前完成,删除与新增进入同一个 commit |
| 异常条目 | 不符合命名规范的条目跳过并警告,既不参与排序也不删除 |

## 发行附件打包

`release-assets.yml` 独立于 `pages.yml`,只负责把构建产物打成 zip 传到对应 Release,正式发行与预发行口径一致:

| 步骤 | 口径 |
|:---:|:---:|
| 触发与校验 | `release` 的 `published` 事件(两态都触发),或手动传 tag;tag 格式正则与 Release 预发行标记的一致性校验同 pages.yml;手动触发额外要求该 tag 的 Release 已存在,否则拒绝补传 |
| 构建 | 检出该 tag,`pnpm install --frozen-lockfile`、type、lint、build |
| 打包 | `dist/` 内容为 zip 根,打包为 `web-<tag>.zip`;`dist/` 不存在即中止 |
| 上传 | `gh release upload --clobber`,重复触发同一 tag 时覆盖同名附件 |
| 签名 | 不做签名: 附件是产物副本,运行时校验走站点与信任材料,网页签名口径见 pages.yml |
