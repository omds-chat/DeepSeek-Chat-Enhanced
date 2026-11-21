# 并行分支的命名与布局

本文记录本仓库与 `main` 没有公共祖先的三条并行分支各自承载什么、内容从哪里来,以及改名前后旧名与新名的对应关系。命名规则本身由组织仓库的 `repo-spec/side-branches.md` 规定,本文只记本仓库的落地情况,不重复规范条文。

## 三条分支

| 分支 | 职责 | 放什么 | 内容来源 |
|:---:|:---:|:---:|:---:|
| `dist-history` | 发布产物与历史版本 | 每次发布的网页产物副本,按发布 tag 分目录,只保留最近 1000 个 | 发布流水线的构建产物 |
| `certs` | 可公开的证书与公钥 | `main` 分支 `certs` 目录的逐字节副本,保留 `certs/` 前缀,内含根证书、各来源 EEC 与其公钥 | `main` 分支的 `certs` 目录整体复制 |
| `trusted-manifest` | 信任清单及其派生数据 | `index.json`(根证书指向、各合集 EEC 的相对路径、吊销列表登记),另有一份按模板渲染的 `README.md` | `.github/scripts/build-trust-index.mjs` 依据 `certs/manifest.json` 生成 |

三条分支都只由 `.github/workflows/pages.yml` 写入,不从 `main` 派生,也不合并回 `main`。发布流水线发现某条分支缺失时报错中止,不代为创建。

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

## 发布流水线的分工

| 阶段 | 行为 |
|:---:|:---:|
| 预检查 | 发布 tag 格式、三条并行分支是否存在、四条分支是否两两无公共祖先 |
| 构建与签名 | 在主工作区构建并执行 `sign-web`,签名结果自校验后再归档 |
| 归档 | 三条分支各自清理工作树、写入内容、裁剪历史版本、commit、打归档 tag、push |
| 合并 | 把构建产物、`certs/`、`index.json` 合并进同一个页面包,再统一上传部署 |

## 页面包的合并口径

页面包不保留每一类数据各自的顶层目录,而是把信任材料摊在站点根:

| 位置 | 内容 |
|:---:|:---:|
| 站点根 | 构建产物(页面、静态资源、`LICENSE`) |
| 站点根 `certs/` | 当前证书目录,来自 `certs` 分支 |
| 站点根 `index.json` | 当前信任清单,来自 `trusted-manifest` 分支 |
| 站点根 `version/latest/`、`version/<tag>/` | 两条信任分支的历史版本合并成一份,目录内同时有 `certs/` 与 `index.json` |

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
