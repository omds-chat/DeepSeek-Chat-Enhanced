# 并行分支的命名与布局

本文记录本仓库三条并行分支(`dist-history`、`certs`、`trusted-manifest`)的落地口径。分支的职责、命名规则与归档流程由组织仓库的 `.github/docs/repo-spec/side-branches.md` 规定,本文不重复其条文,只记本仓库的落地情况;三条分支都只由 `.github/workflows/pages.yml` 写入,不从 `main` 派生,也不合并回 `main`,发布流水线发现某条分支缺失时报错中止,不代为创建。

## 预发行的归档口径

组织级规范之外,本仓库的发布流水线对预发行产物(tag 形如 dsc-x.y.z-XXX.n,XXX 为小写字母串)有两条补充口径:

| 事项 | 口径 |
|:---:|:---:|
| `dist-history`(预发行) | 预发行的产物只落在 `version/<tag>/` 一个目录里,不替换分支根目录,不替换 `version/latest/` |
| 归档(预发行) | 预发行 tag 在三条分支的口径对齐:各自只在 `version/` 下新增 `version/<tag>/` 一个目录(`dist-history` 存产物、`certs` 存证书副本、`trusted-manifest` 存清单),不清理工作树、不动任何分支的根目录与 `version/latest/`,页面包照常合并发布 |

## 旧名与新名的对应关系

| 旧名 | 新名 | 说明 |
|:---:|:---:|:---:|
| `dist` 分支 | `dist-history` 分支 | 内容不变,只改名字 |
| `online-data` 分支 | `certs` 分支 + `trusted-manifest` 分支 | 一条分支拆成两条: `certs/` 目录整体复制到 `certs` 分支,`index.json` 落到 `trusted-manifest` 分支 |
| `single-branch/dist/` 工作区 | `single-branch/dist-history/` 工作区 | 独立仓库工作区,各自自带 `.git` |
| `single-branch/online-data/` 工作区 | `single-branch/certs/` 与 `single-branch/trusted-manifest/` 工作区 | 拆成两个独立仓库工作区 |
| 归档 tag 后缀 `-dist` | `-dist-history` | 后缀与分支名一致 |
| 归档 tag 后缀 `-online-data` | `-certs` 与 `-trusted-manifest` | 后缀与分支名一致 |

仓库内的分支名引用已全部改为新名;旧名只在需要交代历史时以「原名」形式出现。三条分支在本地按组织规范检出为独立工作区,工作区目录不属于主仓库产物。

## 页面包的合并口径

页面包不保留每一类数据各自的顶层目录,而是把信任材料摊在站点根:

| 位置 | 内容 |
|:---:|:---:|
| 站点根 | 构建产物(页面、静态资源、`LICENSE`)。正式发行用本轮构建顶上站点根;预发行不动站点根,维持最近一次正式发行的产物(来自 `dist-history` 分支根) |
| 站点根 `certs/` | 当前证书目录,来自 `certs` 分支根目录 |
| 站点根 `index.json` | 当前信任清单,来自 `trusted-manifest` 分支根目录 |
| 站点根 `version/latest/`、`version/<tag>/` | 三条归档分支的历史版本释放合并成一份,每个版本目录是该版本的完整快照:构建产物(来自 `dist-history`)、`certs/`(来自 `certs` 分支)、`index.json` 与 `README.md`(来自 `trusted-manifest` 分支) |

站点 `version/<tag>/` 的结构:

```text
version/
└── dsc-1.0.0-alpha.1/
    ├── index.html          # 本版页面入口
    ├── assets/             # 本版静态资源
    ├── LICENSE
    ├── certs/              # 本版证书副本,结构与站点根 certs/ 一致
    ├── index.json          # 本版信任清单
    └── README.md           # 本版清单说明
```

同名文件的合并顺序是「产物 -> 证书 -> 清单」,清单分支的 `README.md` 最终生效;各来源互不覆盖对方独有的文件。

这样 `index.json` 里 `certs/ds-chat/ds-chat-root-ca.crt` 这类相对路径在三个位置都成立,消费方用同一个前缀即可取齐证书与清单。

## 运行时的取材口径

网页与插件引擎各按内容类型选镜像前缀,不假设两者同源:

| 内容 | 分支 | 代码位置 |
|:---:|:---:|:---:|
| 信任清单 `index.json` | `trusted-manifest` | `src/services/trust/fetch.ts` 的 `TRUST_MANIFEST_MIRRORS` |
| 根证书、网页 EEC、吊销列表、各合集 EEC | `certs` | `src/services/trust/fetch.ts` 的 `CERT_MIRRORS` |

两个镜像列表按下标一一对应:同一镜像源(jsDelivr、raw.githubusercontent)的清单地址与证书地址成对使用。清单里登记的证书路径一律相对 `certs` 分支根目录,与清单所在分支无关。

## 与主干 `certs/` 目录的区别

| 位置 | 用途 | 谁使用 |
|:---:|:---:|:---:|
| `main` 分支 `certs/` | 构建期依赖的材料:把根证书与网页 EEC 内嵌进产物,并作为签发与验签脚本的输入 | 构建脚本、`scripts/pki/` |
| `certs` 分支 | 对外发布的材料:供网页与合集在运行时取用 | 页面与合集的运行时 |
