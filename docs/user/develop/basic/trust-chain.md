# 信任链与 PKI 签名

本文说明 dsc 的签名体系如何按 OpenSSL PKI 组织: 三个角色各持有什么、证书与签名产物是什么、吊销怎么做、信任数据如何分发,以及当前代码与目标的差距。内容与 `scripts/pki/ca.mjs`、`scripts/pki/pki.mjs`、`scripts/build-online-data.mjs` 的当前实现一致,未实现的能力不写入本文。

## 角色

| 角色 | 承担者 | 持有物 | 职责 |
|:---:|:---:|:---:|:---:|
| 根证书机构(CA) | DeepSeek-Chat-Enhanced 仓库 | 根私钥(离线,不入库)、根证书 | 签发终端签名证书(EEC),维护吊销列表 |
| 终端签名方(EEC) | 插件合集,目前为 awesome-dsc-plugin | EEC 私钥(CI secret)、EEC 证书 | 用 CMS 分离签名给网页与插件文件签名 |
| 独立签名方 | 插件作者,含 omdsc-dev 自身 | 作者密钥对 | 用裸公钥分离签名给插件文件签名 |

信任锚只有根证书。EEC 由根证书签发,不能再签发下级证书;作者签名与 EEC 签名是两条独立的信任路径,互不替代。

## 算法与证书

| 项 | 约定 | 理由 |
|:---:|:---:|:---:|
| 根 CA 密钥 | ECDSA P-256(OpenSSL 原生 PEM) | 与 EEC 同一算法;浏览器 WebCrypto 对 P-256 支持最广,证书链校验必须能在浏览器里完成 |
| 根证书 | X.509 自签名,`keyUsage=critical,keyCertSign,cRLSign`,`basicConstraints=critical,CA:TRUE,pathlen:0`,有效期 3650 天 | 只允许签 EEC,不允许再派生下级 CA |
| EEC 密钥 | ECDSA P-256(OpenSSL 原生 PEM) | OpenSSL 的 CMS 实现对 Ed25519 报 `provider signature failure`,实测不可用 |
| EEC 证书 | X.509 由根 CA 签发,`keyUsage=critical,digitalSignature`,`basicConstraints=critical,CA:FALSE`,有效期 365 天 | 终端签名证书只需要签名用途 |
| 合集签名 | CMS 分离签名,`openssl cms -sign -binary -outform DER -nocerts -noattr` | 逐字节语义,签名与验签都必须带 `-binary`;`-outform DER` 输出裸 CMS,浏览器端可直接解析 |
| 作者签名 | 裸公钥分离签名,`openssl pkeyutl -sign -rawin`(Ed25519) | 作者不需要证书,公钥随合集分发 |

EEC 证书的 CN 取合集名,与 online-data 清单里的合集 id 一致。

## 签发证书

根 CA 只在组织签名环境操作,私钥不进入仓库,也不下发到任何合集。

```
# 生成根私钥与自签名根证书
node scripts/pki/ca.mjs init-root --dir <目录>

# 签发 EEC
ROOT_CA_SECRET=<根私钥路径> ROOT_CA_CERT=<根证书路径> \
  node scripts/pki/ca.mjs issue-eec --csr <CSR> --out <EEC 证书>
```

合集侧生成 EEC 私钥与 CSR,把 CSR 交给根 CA:

```
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out eec_secret.pem
openssl req -new -key eec_secret.pem -out eec.csr -subj '/O=omdsc-dev/CN=<合集名>'
```

`init-root` 只把根私钥写到 `--dir` 指定的目录,并拒绝写入仓库中被追踪的路径;仓库内只允许写到 git 忽略的临时目录。`issue-eec` 在签发后用根证书做一次 `openssl verify` 自检,并要求 CSR 的公钥是 ECDSA P-256。

## 签名

### 合集与网页: CMS 分离签名

EEC 持有方对每个文件单独签名,产物是 `<文件>.sig`:

```
openssl cms -sign -binary -in <文件> -out <文件>.sig \
  -signer eec.pem -inkey eec_secret.pem -nocerts -noattr -outform DER
```

`-binary` 表示按原始字节签名,不做换行规范化,与作者签名的逐字节语义一致;`-nocerts` 表示签名里不带证书,验证方从分发结构里取 `eec.pem`。网页产物对 `dist/` 下的 `.html`、`.js`、`.css` 逐个签名,由 `sign-web` 子命令完成,同时写出按路径排序的 `web_files.json` 清单并对其单独签名,最后把 `eec.pem` 复制到产物目录供校验方取用。签名加 `-outform DER` 输出裸 CMS,浏览器端可直接解析。

### 作者: 裸公钥分离签名

```
openssl genpkey -algorithm ed25519 -out author_secret.pem
openssl pkey -in author_secret.pem -pubout -out author_pub.pem
openssl pkeyutl -sign -rawin -inkey author_secret.pem -in <文件> -out <文件>.author.sig
```

作者公钥随合集分发到 `plugins/<作者>/author_pub.pem`,签名文件与合集签名并存。

## 校验

```
# 合集签名: 根证书作为信任锚,EEC 证书作为候选签名者
openssl cms -verify -binary -inform DER -in <文件>.sig -content <文件> \
  -CAfile root_ca.crt -certfile eec.pem

# 作者签名
openssl pkeyutl -verify -pubin -inkey author_pub.pem -rawin -in <文件> -sigfile <文件>.author.sig

# 证书链
openssl verify -CAfile root_ca.crt eec.pem
```

整目录校验用 `verify-web` 子命令: 先校验证书链,再逐个校验 `.sig`,缺失签名与孤儿签名都计入失败清单,有任何失败时以非零状态退出。

> OpenSSL 3.5 的 `openssl cms` 没有 `-CRLfile` 选项,启用吊销检查时要把根证书与 CRL 拼成同一个 `-CAfile` 证书库,再追加 `-crl_check`。`verify-web --crl <文件>` 已按这个方式实现。

## 吊销

根 CA 维护吊销列表(CRL)。被吊销的通常是泄露或轮换下来的 EEC。

```
ROOT_CA_SECRET=<根私钥路径> ROOT_CA_CERT=<根证书路径> \
  node scripts/pki/ca.mjs gen-crl --out crl.pem --days 30 --revoke <序列号>
```

`--revoke` 可重复给出,接受十六进制与冒号分隔写法,取证书的 `serial`。OpenSSL 3.5 已移除 `openssl crl -gen`,因此工具改用 `openssl ca -gencrl`,并在临时目录自建 `index.txt`、`serial`、`crlnumber` 的最小 CA 结构。

CRL 生成后写入分发结构的 `crl.pem`,并在 `index.json` 的 `crl` 字段登记。命令行验证方启用吊销检查时,被吊销的 EEC 会让签名校验失败并给出 `certificate revoked`。

运行时按 `index.json` 的 `crl` 字段决定是否做吊销检查:

| `crl` 取值 | 运行时行为 |
|:---:|:---:|
| `"crl.pem"` | 拉取 CRL,校验根证书 `keyUsage` 含 `cRLSign`、CRL 由同一张根证书签发、当前时间落在本次更新与下次更新之间、签名可用根证书公钥验证,再逐个比对清单内 EEC 的序列号 |
| `null` | 跳过吊销检查,只校验证书链 |

被吊销的 EEC 让该合集判定为不可信,市场与插件面板给出的原因是「证书已被吊销」。CRL 拉取失败、解析失败、已过期或与根证书不配对时,吊销状态无法确认,两条路径都判失败:信任清单把相关合集标为不可信,网页产物只给出证书链警告,均不静默退化为只校验证书链。

## 重签时机

| 情形 | 是否重签 | 原因 |
|:---:|:---:|:---:|
| 文件内容变化 | 该文件必须重签 | CMS 签名绑定文件字节 |
| EEC 轮换 | 该 EEC 签过的全部文件重签 | 签名者证书变了,旧签名仍可验但会指向旧证书 |
| 根 CA 轮换 | 所有 EEC 重签并重新分发根证书 | 信任锚变了,旧 EEC 全部失去信任 |
| 新增合集 | 只需签发新 EEC 并更新 index.json | 其他合集不受影响 |
| EEC 泄露或私钥丢失 | 签发新 EEC 并把旧 EEC 序列号写进 CRL | 旧签名仍能验通过,靠吊销让验证方拒绝 |
| 只改 `meta.json`、`datalog.json` 等目录数据 | 视分发约定而定 | 这些文件本身也在签名范围内时同样要重签 |

## 已废弃的产物

下列旧结构由本约定取代,不再生成:

| 旧产物 | 取代者 |
|:---:|:---:|
| `plugin_sign.json` | 插件文件的 `.sig`(CMS 分离签名)与 `.author.sig`(作者裸公钥签名) |
| `plugin_set_sign.json` | 合集根目录的 `eec.pem` 证书链,合集可信性由根 CA 签发的 EEC 证明 |
| `web_sign.json` | 网页文件的 `.sig`(CMS 分离签名)与 `web_files.json` 清单 |
| Ed25519 + SHA-512 摘要的 JSON 签名结构 | 逐字节 CMS 分离签名与 `pkeyutl -rawin` 裸公钥签名 |

## 分发结构

### online-data 分支

`online-data` 是与 `main` 没有公共祖先的孤立分支,只存放网页在运行时拉取并核对的信任数据。

```
online-data/
├── index.json          # 信任清单
├── root_ca.crt         # 根证书
├── crl.pem             # 吊销列表(可选,生成后才有)
├── web/
│   └── eec.pem         # 网页签名的终端签名证书
└── collections/
    └── <合集名>/
        └── eec.pem     # 该合集的终端签名证书
```

`index.json` 的结构:

```json
{
  "schemaVersion": 2,
  "rootCa": "root_ca.crt",
  "crl": "crl.pem",
  "collections": [
    { "id": "<合集名>", "eec": "collections/<合集名>/eec.pem" }
  ]
}
```

没有 CRL 时 `crl` 为 `null`。

生成命令在 `main` 工作树上执行,输出目录属于生成物目录:

```
pnpm run build:online-data -- --root-ca root_ca.crt --web-eec web-eec.pem --eec awesome-dsc-plugin=../awesome-dsc-plugin/eec.pem --out <输出目录>
```

脚本写盘前用 `openssl verify` 确认每张 EEC 确实由该根证书签发,并检查 EEC 带 `digitalSignature`、不是 CA、未过期;任一项不通过就不写出任何文件。给出 `--crl` 时还会校验 CRL 确实由该根证书签发。

### 插件合集

```
<collection>/
├── eec.pem                 # 终端签名证书,随 Pages 分发
├── meta.json
├── datalog.json
├── tags.json
└── plugins/
    └── <作者>/
        ├── author_pub.pem        # 作者公钥(OpenSSL PEM)
        ├── plugin_manifest.json
        └── <插件>/
            ├── versions.json
            └── <x.y.z>/
                ├── meta.json
                ├── meta.json.sig        # 合集 CMS 签名
                ├── plugin.js
                ├── plugin.js.sig        # 合集 CMS 签名
                └── plugin.js.author.sig # 作者裸公钥签名(可选)
```

### 插件模板产物

```
dist/
├── meta.json
├── plugin.js
├── meta.json.author.sig    # 启用作者签名时生成
├── plugin.js.author.sig    # 启用作者签名时生成
├── author_pub.pem          # 启用作者签名时生成,交给合集放到 plugins/<作者>/author_pub.pem
└── MUST_PLUSH_WITH_PACKAGE
```

## 命令行工具

`scripts/pki/ca.mjs` 提供全部 CA 侧操作,通过 `pnpm run pki -- <子命令>` 调用。底层封装在 `scripts/pki/pki.mjs`,只包装 OpenSSL,不实现密码学运算。

| 子命令 | 作用 | 关键参数 |
|:---:|:---:|:---:|
| `init-root` | 生成 ECDSA P-256 根私钥与自签名根证书 | `--dir`、`--days`、`--org`、`--name`、`--force` |
| `issue-eec` | 用根私钥签发 EEC | `--csr`、`--out`、`--days`、`--force` |
| `sign-web` | 对目录下的 `.html`/`.js`/`.css` 生成 CMS 分离签名 | `--dir`、`--eec`、`--key` |
| `verify-web` | 用根证书与目录内的 `eec.pem` 校验全部签名 | `--dir`、`--root-ca`、`--eec`、`--crl` |
| `gen-crl` | 生成 CRL | `--out`、`--days`、`--revoke` |

`issue-eec` 与 `gen-crl` 从环境变量 `ROOT_CA_SECRET`、`ROOT_CA_CERT` 读取根私钥与根证书路径。

## 私钥边界

| 密钥 | 可以出现在哪里 | 不得出现在哪里 |
|:---:|:---:|:---:|
| 根私钥 | 组织离线签名环境 | 仓库任何被追踪的路径、CI secrets 之外的任何位置、产物 |
| EEC 私钥 | 合集 CI 的 secrets | 公开仓库文件、Pages 产物 |
| 根证书 | 仓库、online-data 分支、产物 | 无需保密 |
| EEC 证书 `eec.pem` | 合集根目录、online-data 分支、网页产物目录 | 无需保密 |
| 作者私钥 | 作者本机 | 合集仓库、产物 |

根 CA 只签发 EEC,不参与日常签名;合集 CI 只用 EEC 私钥签文件,不接触根私钥。

## 当前实现状态

网页产物与合集信任都已按证书链落地,吊销检查也已接入运行时:

| 项 | 现状 | 下一步 |
|:---:|:---:|:---:|
| 网页产物签名 | `sign-web` 子命令产出 `<文件>.sig` 与 `web_files.json` 清单 | 已完成 |
| 运行时校验 | 页面用内嵌根证书与 `web/eec.pem` 的证书链校验全部签名 | 已完成 |
| 合集信任 | 市场按 online-data 的 `index.json` 取各合集 EEC,校验证书链后判定可信 | 已完成 |
| 吊销检查 | `index.json` 登记 `crl` 时,网页 EEC 与合集 EEC 都按 CRL 检查吊销 | 已完成 |

网页产物的签名范围、清单结构与校验流程见 [网页签名与运行时校验](web-signature.md)。

## 排错

| 现象 | 常见原因 |
|:---:|:---:|
| `openssl cms -sign` 报 `provider signature failure` | EEC 私钥是 Ed25519,必须换成 ECDSA P-256 |
| `verify-web` 报证书链校验失败 | 目录内的 `eec.pem` 不是该根证书签发的,或换根后没有重新签发 |
| `verify-web` 报某个文件 CMS 校验失败 | 该文件在签名后被改动过,或签名不是对当前字节生成的 |
| `verify-web` 报 `certificate revoked` | EEC 已被 `gen-crl` 吊销 |
| `build:online-data` 报 EEC 不是由该根证书签发 | 传入的 `eec.pem` 与 `--root-ca` 不配对 |
| 网页运行时提示证书链校验未通过 | online-data 缺少 `web/eec.pem`,或该证书不是当前根证书签发的 |
| 市场提示「证书已被吊销」 | 该合集的 EEC 序列号已写进 `crl.pem`,需要签发新 EEC 并重新生成 CRL,`--revoke` 只列仍需吊销的序列号 |
| 市场把整份清单判为不可信 | `crl.pem` 拉取失败、已过期、不是当前根证书签发的,或根证书 `keyUsage` 缺 `cRLSign` |
| `init-root` 报不得写入仓库被追踪的路径 | 根私钥只能写到仓库外的目录或 git 忽略的临时目录 |

## 延伸阅读

- [网页签名与运行时校验](web-signature.md)
- [dsc 插件产物规范](plugin-product-spec.md)
