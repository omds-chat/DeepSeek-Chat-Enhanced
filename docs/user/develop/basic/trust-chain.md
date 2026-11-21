# 信任链与 PKI 签名

本文说明 dsc 的签名体系如何按 OpenSSL PKI 组织: 三个角色各持有什么、证书与签名产物是什么、吊销怎么做、信任数据如何分发。内容与 `scripts/pki/ca.mjs`、`scripts/pki/pki.mjs`、`rspack.config.ts` 与 `src/services/` 下的证书校验模块一致,未实现的能力不写入本文。

公开证书与公钥统一放在 `main` 分支的 `certs` 目录,该目录是它们的唯一来源,私钥不进入该目录。运行时看到的在线证书由 CI 把 `certs` 目录原样放进并行的 `certs` 分支得到,因此在线路径都是 `certs/...` 形式。

## 角色

| 角色 | 承担者 | 持有物 | 职责 |
|:---:|:---:|:---:|:---:|
| 根证书机构(CA) | DeepSeek-Chat-Enhanced 仓库 | 根私钥(离线,不入库)、根证书 | 签发终端签名证书(EEC),维护吊销列表 |
| 终端签名方(EEC) | 插件合集,如 awesome-dsc-plugin 与 dsc-inner-plugin | EEC 私钥(CI secret)、EEC 证书 | 用 CMS 分离签名给网页与插件文件签名 |
| 独立签名方 | 插件作者,含 omds-chat 自身 | 作者密钥对 | 用裸公钥分离签名给插件文件签名 |

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

EEC 证书的 CN 取合集名,与 `trusted-manifest` 分支清单里的合集 id 一致。

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
openssl req -new -key eec_secret.pem -out eec.csr -subj '/O=omds-chat/CN=<合集名>'
```

`init-root` 只把根私钥写到 `--dir` 指定的目录,并拒绝写入仓库中被追踪的路径;仓库内只允许写到 git 忽略的临时目录。`issue-eec` 在签发后用根证书做一次 `openssl verify` 自检,并要求 CSR 的公钥是 ECDSA P-256。

## 签名

### 合集与网页: CMS 分离签名

EEC 持有方对每个文件单独签名,产物是 `<文件>.sig`:

```
openssl cms -sign -binary -in <文件> -out <文件>.sig \
  -signer <EEC 证书> -inkey eec_secret.pem -nocerts -noattr -outform DER
```

`-binary` 表示按原始字节签名,不做换行规范化,与作者签名的逐字节语义一致;`-nocerts` 表示签名里不带证书,验证方从分发结构里取对应的 EEC 证书。网页产物对 `dist/` 下的 `.html`、`.js`、`.css` 逐个签名,由 `sign-web` 子命令完成,同时写出按路径排序的 `web_files.json` 清单并对其单独签名,最后把 EEC 证书按 certs 布局写到产物目录的 `certs/ds-chat-pages/ds-chat-pages-eec.crt` ,不再写入产物根目录的 `eec.pem` ;旧布局的 `eec.pem` 只保留读取侧的兼容回退,待全部产物与来源迁移完成后可连同回退逻辑一起移除。签名加 `-outform DER` 输出裸 CMS,浏览器端可直接解析。

插件合集的目录数据不再逐文件签名,改为每层一份哈希清单并只对清单签名,插件产物 `plugin.js` 仍逐版本单独签名,见下文「合集目录: 三层哈希清单」。

### 作者: 裸公钥分离签名

```
openssl genpkey -algorithm ed25519 -out author_secret.pem
openssl pkey -in author_secret.pem -pubout -out author_pub.pem
openssl pkeyutl -sign -rawin -inkey author_secret.pem -in <文件> -out <文件>.author.sig
```

作者公钥随合集分发到 `plugins/<作者>/author_pub.pem`,签名文件与合集签名并存。

### 合集目录: 三层哈希清单

合集的分发结构分三层,每层各有一份 `manifest.json` 与一份 `manifest.json.sig`,层与层之间互不引用:

| 层 | 位置 | 覆盖的文件(相对该层目录) |
|:---:|:---:|:---:|
| L1 | 合集根 | `meta.json`、`plugins.json`、`tags.json`、`plugins/author_manifest.json` |
| L2 | `plugins/<作者>/` | `author_pub.pem`、`plugin_manifest.json` |
| L3 | `plugins/<作者>/<插件>/` | `versions.json`、`<版本>/meta.json` |

清单格式:

```json
{
  "schemaVersion": 1,
  "revision": 1,
  "files": [{ "path": "plugins.json", "sha512": "<小写十六进制>" }]
}
```

`path` 是相对该层目录的路径,`sha512` 是文件字节的 SHA-512 小写十六进制;`revision` 是正整数,内容每变一次就递增。签名与文件签名同一口径:

```
openssl cms -sign -binary -md sha512 -in manifest.json -out manifest.json.sig \
  -signer <EEC 证书> -inkey eec_secret.pem -nocerts -noattr -outform DER
```

L3 不覆盖 `plugin.js`:产物由每版本的 `plugin.js.sig` 独立签名,清单只管目录数据。原先的 `meta.json.sig` 已取消,该版本 `meta.json` 的完整性由 L3 清单覆盖。

校验顺序固定为「先证书链、再 CMS 签名、最后结构」:EEC 证书链用内置根证书校验,不通过时不再发起 CMS 验签;签名通过后检查 `schemaVersion`、`revision` 为正整数、`path` 是层内相对路径、`sha512` 是 128 位小写十六进制。

消费方(dsc 本体)的做法:

| 环节 | 做法 |
|:---:|:---:|
| 目录数据 | 先取 L1 清单并验签,再取插件目录索引 `plugins.json` 与根 `meta.json` 并比对哈希 |
| 插件详情与安装 | 先取 L3 清单并验签,再用它校验 `versions.json` 与该版本 `meta.json` |
| 作者公钥 | 先取 L2 清单并验签,校验 `author_pub.pem` 后才用于作者签名验证 |
| 产物 | 仍按 `plugin.js.sig` 验签,不依赖任何清单 |
| 降级 | 清单缺失或验签失败时不阻断,结论降级为「目录数据未校验」,产物结论不受影响 |
| revision 记忆 | 每层路径记住见过的最大 `revision`,本次小于记录值时只提示,不阻断 |

### 整站签名: 清单加逐文件签名

不是所有来源都发布三层哈希清单。只发布整站签名的来源(典型是内部合集)对站点内的 `.html`、`.js`、`.css`、`.json` 逐个生成 CMS 分离签名 `<文件>.sig`,把被签名的路径写进 `web_files.json` 并对清单自身单独签名,证书随站点分发。这类来源没有 `manifest.json`;`plugin.js` 仍按版本单独签名,签名者是同一张整站签名证书。

dsc 本体按特征文件识别来源属于哪一类:先探测 `manifest.json` 与 `plugins.json`,都取到按合集处理;其次探测 `web_files.json` 且来源证书已取到,按整站处理;两种都不成立时按未确认处理,目录照常展示、不报错。合集优先,整站模型只作为第二模型,不影响合集模型的任何取件与结论。

整站模型的校验顺序:

| 顺序 | 做法 |
|:---:|:---:|
| 1 | 按三档取件取来源证书,顺序见「运行时验签的证书来源」 |
| 2 | 用构建内嵌的根证书在本地校验证书链;链不通过即失败,不再发起 CMS 验签 |
| 3 | 用证书验 `web_files.json.sig` |
| 4 | 按清单逐文件验签消费方实际读到的文件;文件不在清单内按失败处理,签名文件缺失按未校验处理 |
| 5 | `plugin.js` 的整站签名在安装与启动时按 `plugin.js.sig` 验签,与合集 CMS 验签同一条通道 |
| 6 | 作者签名 `plugin.js.author.sig` 为可选材料,失败只警告;整站模型没有 L2 清单,作者公钥不做哈希把关 |

结论仍是三态:通过、未校验、失败。清单或签名缺失、证书缺失、本地不具备校验条件按未校验;链不通过、清单签名不通过、文件签名不通过按失败。失败只把目录数据结论降级为未校验,不阻断安装,也不改变来源结论。

整站签名不代替作者签名:作者签名由作者用自己持有的私钥签,合集只做收录与整站签名(或合集签名),两条路径互不替代。

## 校验

```
# 清单签名: 与文件签名同一口径,内容为 manifest.json 的字节
openssl cms -verify -binary -inform DER -in manifest.json.sig -content manifest.json \
  -CAfile certs/ds-chat/ds-chat-root-ca.crt -certfile certs/ds-chat-pages/ds-chat-pages-eec.crt

# 文件哈希
openssl dgst -sha512 -r <文件>

# 合集签名: 根证书作为信任锚,EEC 证书作为候选签名者
openssl cms -verify -binary -inform DER -in <文件>.sig -content <文件> \
  -CAfile certs/ds-chat/ds-chat-root-ca.crt -certfile certs/ds-chat-pages/ds-chat-pages-eec.crt

# 作者签名
openssl pkeyutl -verify -pubin -inkey author_pub.pem -rawin -in <文件> -sigfile <文件>.author.sig

# 证书链
openssl verify -CAfile certs/ds-chat/ds-chat-root-ca.crt certs/ds-chat-pages/ds-chat-pages-eec.crt
```

整目录校验用 `verify-web` 子命令: 先校验证书链,再逐个校验 `.sig`,缺失签名与孤儿签名都计入失败清单,有任何失败时以非零状态退出。

> OpenSSL 3.5 的 `openssl cms` 没有 `-CRLfile` 选项,启用吊销检查时要把根证书与 CRL 拼成同一个 `-CAfile` 证书库,再追加 `-crl_check`。`verify-web --crl <文件>` 已按这个方式实现。

### 运行时验签的证书来源

验签证书的来源不再是必要条件,信任锚才是。根 CA 在构建时内嵌进产物(`__ROOT_CA_PEM__`,由 `rspack.config.ts` 读取 `certs/ds-chat/ds-chat-root-ca.crt` 写入),证书字节从哪里来并不重要:

| 证书来源 | 取用条件 |
|:---:|:---:|
| 信任清单登记的合集 `eec`,形如 `certs/<合集 id>/<合集 id>-eec.crt` | 清单已登记该来源时优先使用,省一次请求 |
| 来源站点的 `<base>/certs/<合集 id>/<合集 id>-eec.crt` | 清单未登记该来源时使用,这是来源证书当前公开发布的布局,目录名与文件名都取合集 id |
| 来源站点的 `<base>/certs/<合集 id>-eec.crt` | 兼容旧站点的扁平布局;只在旧站点存在,新来源不再提供该路径 |
| 来源站点根目录的 `<base>/eec.pem` | 最后兜底,前两档都取不到时才尝试 |

来源证书的取件顺序固定为: 信任清单登记的 `eec`、`<base>/certs/<合集 id>/<合集 id>-eec.crt`、`<base>/certs/<合集 id>-eec.crt`、`<base>/eec.pem`。前一项取到就不再请求后一项;三档都取不到,才按「拿不到证书」处理。

前两档的取舍: 嵌套布局是公开发布布局,同一来源的证书可以只按合集 id 拼出路径,不需要清单登记也能取到;扁平布局只在旧站点存在,保留它是为了不必逼迫旧站点与仓库同时迁移,代价是未登记来源每次都要多发一次请求,而且同一份证书可能在两种路径上各放一份、需要各自刷新。

合集 id 优先取该来源在信任清单登记的 id,其次取清单登记路径里的合集目录名;清单没有登记该来源时,用来源站点的名称归一化(小写,非字母数字折叠成单个连字符)。归一化只用于在本地推导路径,不改变来源的信任结论。

取到的证书都必须先在本地用内置根 CA 校验证书链,链校验通过才会交给 CMS 验签;链校验不通过时结论为 `failed`,并且不会发起 CMS 验签。吊销检查使用信任清单分发的 CRL,CRL 本身也用同一张根证书校验。

证书的取用分在线与离线两种情形: 在线时信任清单登记的 `eec` 优先,没有登记时按上述取件顺序向来源站点请求;离线时改用安装记录里已存的 `eec`,不再发起请求。两种情形都只认内嵌根证书给出的链校验结论。

根证书内嵌是离线运行的前提: 离线时拉不到任何在线副本,没有内嵌根证书就无法校验证书链,因此 `certs/ds-chat/ds-chat-root-ca.crt` 缺失时构建直接失败。在线那份同名证书只作便利与比对,与内嵌证书不一致时仍按内置根证书校验,并在控制台留一条提示。

网页签名的终端证书同样按 `certs` 布局取用: 在线路径为 `certs/ds-chat-pages/ds-chat-pages-eec.crt` ;离线时用构建内嵌的同名证书,注入为 `__PAGES_EEC_PEM__`。

安装记录与启动恢复按同一口径给出来源结论:

| 结论 | 含义 | 触发条件 |
|:---:|:---:|:---:|
| `confirmed` | 来源已确认 | 证书链在本地校验通过,且 CMS 验签通过 |
| `failed` | 校验未通过 | 证书链不通过(过期、非本根签发、被吊销),或拿不到证书、验签不通过 |
| `unknown` | 无法确认来源 | 完全没有来源信息 |
| `local` | 本地安装 | 用户上传的离线包,没有来源,不参与来源判定 |

链校验失败与证书吊销是确定的负面结论,按 `failed` 处理并区分原因 `chain` 与 `revoked`;拿不到证书或验签不通过同样按 `failed` 处理,原因为 `other`。其中信任清单登记了该来源的证书、但来源站点取不到证书文件的情形,界面单列「来源证书缺失」,不再落到通用的「来源校验未通过」。

安装记录用 `eec_anchored` 标记证书链是否已在本地校验通过,并用 `source_trust`、`trust_failure` 保存信任清单的判定结果。旧记录的 `eec_anchored` 不再直接采信,启动恢复时按存储的证书重新做一次链校验并重写该标记。

### 在线与离线的材料选取

产物可能在线运行,也可能离线运行(本地打开或本地服务器)。两种情形的规则一致: 信任锚永远是构建内嵌的根证书,在线副本只是备选材料,而且必须先在本地通过校验才会被采用。

| 材料 | 在线 | 离线 | 判据 |
|:---:|:---:|:---:|:---:|
| 根证书 | 拉 `certs/ds-chat/ds-chat-root-ca.crt` 只做比对 | 不请求 | 与内嵌不一致时用内嵌并告警;根证书不能用自己验证自己 |
| 网页签名 EEC | 取 `certs` 分支副本,并在内嵌根证书下校链 | 用构建内嵌的 `__PAGES_EEC_PEM__` | 取不到、无法解析或链不通过都回退内嵌 |
| 来源 EEC | 优先用信任清单所登记的那份,未登记时取来源站点的 `certs/<合集 id>/<合集 id>-eec.crt`,取不到再试旧站点的 `certs/<合集 id>-eec.crt` 与最旧的 `eec.pem` | 用安装记录里已存的 `eec` | 一律用内嵌根证书校链,链不通过不进入 CMS 验签 |
| CRL | 按 `index.json` 的 `crl` 登记取并验签 | 吊销状态视为未知 | 未知时不判定任何证书已吊销,也不阻断任何操作 |

选取顺序与判据:

| 顺序 | 行为 |
|:---:|:---:|
| 1 | `navigator.onLine` 明确为 `false` 时判定离线,一个材料请求都不发 |
| 2 | 为 `true` 时按「尝试 + 短超时 + 回退」处理,单个材料请求最长 1 秒,失败就换下一个镜像 |
| 3 | 拿到在线副本先在本地校验: 根证书只比对,网页 EEC 必须在内嵌根证书下通过链校验,CRL 必须能由内嵌根证书验签 |
| 4 | 校验不通过按「在线材料不可用」处理,回退内嵌材料或安装记录里已存的那份,并留一条提示 |

`navigator.onLine` 只决定是否需要发请求,不决定材料是否可用: 它为 `true` 时仍可能无网,所以在线分支一律带短超时与回退;它为 `false` 时既不发请求,也不据此判定任何证书不可信。

### 信任清单的角色

信任清单(`trusted-manifest` 分支的 `index.json`)降级为策略层,不再是验签的必要条件:

| 用途 | 说明 |
|:---:|:---:|
| 公开查验 | 登记各合集的 EEC,供用户与第三方核对哪些来源被官方认可 |
| 证书优先 | 已登记时优先用清单里的证书,省一次来源站点的请求 |
| 吊销分发 | 分发 CRL,吊销结论仍在本地用内置根证书校验 |
| 界面展示 | 给出 `trusted`、`endorsed`、`untrusted`、`unverified` 判定,只用于显示是否被官方认可 |

未在清单登记不等于不可信: 这类来源的证书链与验签同样按本地规则校验,通过即为 `confirmed`,界面只额外补一条「未在官方清单登记」的中性标注。

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
| 离线,或 CRL 取不到、无法解析、已过期、验签不通过 | 吊销状态视为未知,既不判定任何证书已吊销,也不阻断任何操作 |

被吊销的 EEC 让该合集判定为不可信,市场与插件面板给出的原因是「证书已被吊销」。吊销状态无法确认时按在线与离线分开处理: 离线属预期情形,按未知处理,不阻断;在线且清单登记了 CRL 却取不到或验签不通过时,信任清单把登记了 CRL 的合集标为不可信,网页产物保留一条提示并按未知继续校验。

## 重签时机

| 情形 | 是否重签 | 原因 |
|:---:|:---:|:---:|
| 文件内容变化 | 该文件必须重签 | CMS 签名绑定文件字节 |
| EEC 轮换 | 该 EEC 签过的全部文件重签 | 签名者证书变了,旧签名仍可验但会指向旧证书 |
| 根 CA 轮换 | 所有 EEC 重签并重新分发根证书 | 信任锚变了,旧 EEC 全部失去信任 |
| 新增合集 | 只需签发新 EEC 并更新 index.json | 其他合集不受影响 |
| EEC 泄露或私钥丢失 | 签发新 EEC 并把旧 EEC 序列号写进 CRL | 旧签名仍能验通过,靠吊销让验证方拒绝 |
| 只改 `meta.json`、`plugins.json` 等目录数据 | 改哪层就重签哪层的清单,并把该层 `revision` 加一 | 清单登记的是文件字节的哈希,文件变了旧清单就必然不匹配 |
| 只改 `plugin.js` | 重签 `plugin.js.sig` | 产物不在三层清单内,清单不必改动 |

## 已废弃的产物

下列旧结构由本约定取代,不再生成:

| 旧产物 | 取代者 |
|:---:|:---:|
| `plugin_sign.json` | 插件文件的 `.sig`(CMS 分离签名)与 `.author.sig`(作者裸公钥签名) |
| `plugin_set_sign.json` | 合集根目录的 `eec.pem` 证书链,合集可信性由根 CA 签发的 EEC 证明 |
| `web_sign.json` | 网页文件的 `.sig`(CMS 分离签名)与 `web_files.json` 清单 |
| `meta.json.sig` | 三层哈希清单中的 L3 清单 |
| Ed25519 + SHA-512 摘要的 JSON 签名结构 | 逐字节 CMS 分离签名与 `pkeyutl -rawin` 裸公钥签名 |

## 分发结构

### 三条并行分支

`dist-history`、`certs`、`trusted-manifest` 三条分支都与 `main` 没有公共祖先,各自只承载一类数据,由发布流水线写入,不从 `main` 派生,也不合并回 `main`。命名与职责遵循组织仓库的 `repo-spec/side-branches.md`,本仓库的对应关系与工作区位置见 [并行分支的命名与布局](../../../design/side-branches.md)。

| 分支 | 放什么 | 内容来源 |
|:---:|:---:|:---:|
| `dist-history` | 每次发布的网页产物副本,按发布 tag 分目录 | 发布流水线的构建产物 |
| `certs` | `main` 分支 `certs` 目录的逐字节副本,保留 `certs/` 前缀 | `main` 分支的 `certs` 目录整体复制 |
| `trusted-manifest` | 信任清单 `index.json` 与可选的 `crl.pem` | `.github/scripts/build-trust-index.mjs` 依据 `certs/manifest.json` 生成 |

`certs` 分支的结构:

```
certs/
├── certs/                                  # 与 main 分支的 certs 目录逐字节一致
│   ├── ds-chat/
│   │   ├── ds-chat-root-ca.crt             # 根证书,与构建内嵌的是同一份
│   │   └── ds-chat-root-ca-secret.pub      # 根证书公钥
│   ├── ds-chat-pages/
│   │   ├── ds-chat-pages-eec.crt           # 网页签名的终端签名证书
│   │   └── ds-chat-pages-eec-secret.pub
│   ├── dsc-inner-plugin/
│   │   └── dsc-inner-plugin-eec.crt
│   ├── awesome-dsc-plugin/
│   │   └── awesome-dsc-plugin-eec.crt      # 该合集的终端签名证书
│   ├── manifest.json                       # 合集证书登记清单
│   └── schemas/
├── README.md                               # 分支职责说明
└── version/                                # 按发布 tag 归档的副本,保留最近 1000 个
```

`trusted-manifest` 分支的结构:

```
trusted-manifest/
├── index.json                              # 信任清单
├── README.md                               # 发布流水线按模板重写
├── crl.pem                                 # 吊销列表(可选,生成后才有)
└── version/                                # 按发布 tag 归档的副本,保留最近 1000 个
```

`index.json` 的结构(路径均相对 `certs` 分支根目录):

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

当前流水线不生成吊销列表,`crl` 固定为 `null`;生成后按 `certs` 分支下的路径登记,运行时用同一个镜像前缀取用。清单结构由 [certs/schemas/trust-index.schema.json](../../../../certs/schemas/trust-index.schema.json) 约束,合集登记清单由 [certs/schemas/plugin-set-manifest.schema.json](../../../../certs/schemas/plugin-set-manifest.schema.json) 约束。

代码里只硬编码 `index.json` 的位置(`trusted-manifest` 分支根目录,即该分支镜像地址的前缀),根证书与各合集 EEC 的路径一律取自 `index.json` 并按 `certs` 分支的镜像前缀解析,不另写一套。

发布流水线在最后阶段把两条信任分支的内容合并进同一个页面包: `certs/` 与 `index.json` 都落在站点根,`version/latest` 与 `version/<tag>` 内同时有两者,同一份相对路径因此在分支镜像与页面包里写法一致。原先由单一分支同时承载证书与清单,现在按「证书本体」与「信任清单」拆成 `certs` 与 `trusted-manifest` 两条分支。

`certs` 目录由 CI 整体复制,`index.json` 由同一流程写出;更早的生成器(原名 `build:online-data`,已退役)写的是切分结构(`root_ca.crt`、`collections/<合集名>/eec.pem`、`web/eec.pem`),与 `certs` 布局不一致,发布流水线不再使用它。

### 插件合集

```
<collection>/
├── certs/
│   └── <合集 id>/
│       └── <合集 id>-eec.crt   # 终端签名证书,随 Pages 分发;来源证书的公开发布路径
├── eec.pem                     # 旧布局,仅作兼容兜底;sign-web 不再生成,已迁移的来源不再提供
├── meta.json
├── plugins.json
├── tags.json
├── manifest.json               # L1 清单
├── manifest.json.sig           # L1 清单的 CMS 签名
└── plugins/
    ├── author_manifest.json
    └── <作者>/
        ├── author_pub.pem        # 作者公钥(OpenSSL PEM)
        ├── plugin_manifest.json
        ├── manifest.json         # L2 清单
        ├── manifest.json.sig     # L2 清单的 CMS 签名
        └── <插件>/
            ├── versions.json
            ├── manifest.json         # L3 清单
            ├── manifest.json.sig     # L3 清单的 CMS 签名
            └── <x.y.z>/
                ├── meta.json
                ├── plugin.js
                ├── plugin.js.sig         # 合集 CMS 签名
                └── plugin.js.author.sig  # 作者裸公钥签名(可选)
```

三份清单各自只覆盖本层目录内的文件,不引用其他层的清单;`plugin.js` 不在任何清单内,由同目录的 `plugin.js.sig` 单独签名。

`plugin.js.author.sig` 是可选材料:作者不签名、只给签名不给公钥、或验签不通过,都不影响合集签名与安装,运行时分别按未校验与失败记录,只提示、不阻断。

### 只发布整站签名的来源

```
<collection>/
├── eec.pem                        # 整站签名证书,签发侧写出到站点根目录
├── certs/
│   └── <合集 id>/
│       └── <合集 id>-eec.crt      # 同一张证书的公开发布布局,可选
├── web_files.json                 # 整站清单,列出被逐文件签名的路径
├── web_files.json.sig             # 整站清单的 CMS 签名
├── meta.json / meta.json.sig
├── plugins.json / plugins.json.sig
└── plugins/
    └── <作者>/
        └── <插件>/
            ├── versions.json / versions.json.sig
            └── <x.y.z>/
                ├── meta.json / meta.json.sig
                ├── plugin.js / plugin.js.sig        # 整站签名,签名者同上
                └── plugin.js.author.sig             # 作者裸公钥签名(可选)
```

根目录与插件目录下的 `.json` 文件都在整站签名范围内,因此目录数据的完整性由逐文件签名覆盖,不需要三层清单。读取侧两种证书布局都认:根目录的 `eec.pem` 是第三档兜底,`certs/<合集 id>/<合集 id>-eec.crt` 是第一档;签发侧目前两处工具链分别写出其中一种,读取侧不需要区分。

### 插件模板产物

```
dist/
├── meta.json
├── plugin.js
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
| `sign-web` | 对目录下的 `.html`/`.js`/`.css` 生成 CMS 分离签名,并把证书按 certs 布局写入产物目录 | `--dir`、`--eec`、`--key` |
| `verify-web` | 用根证书与目录内的 EEC 证书校验全部签名;默认取 `certs/ds-chat-pages/ds-chat-pages-eec.crt` ,旧布局的 `eec.pem` 只作兼容回退 | `--dir`、`--root-ca`、`--eec`、`--crl` |
| `gen-crl` | 生成 CRL | `--out`、`--days`、`--revoke` |

`issue-eec` 与 `gen-crl` 从环境变量 `ROOT_CA_SECRET`、`ROOT_CA_CERT` 读取根私钥与根证书路径;这两个变量只属于签发工具,与构建无关,构建内嵌根证书直接读 `certs/ds-chat/ds-chat-root-ca.crt`。

## 私钥边界

| 密钥 | 可以出现在哪里 | 不得出现在哪里 |
|:---:|:---:|:---:|
| 根私钥 | 组织离线签名环境 | 仓库任何被追踪的路径、CI secrets 之外的任何位置、产物 |
| EEC 私钥 | 合集 CI 的 secrets | 公开仓库文件、Pages 产物 |
| 根证书 | `certs/ds-chat/`、`certs` 分支、产物 | 无需保密 |
| EEC 证书 | `certs/<合集名>/`、`certs/ds-chat-pages/`、`certs/dsc-inner-plugin/`、合集根目录的 `certs/`、`certs` 分支、网页产物的 `certs/ds-chat-pages/` | 无需保密 |
| 作者私钥 | 作者本地 | 合集仓库、产物 |

根 CA 只签发 EEC,不参与日常签名;合集 CI 只用 EEC 私钥签文件,不接触根私钥。

## 实现范围

网页产物与合集信任都按证书链校验,吊销检查也接入运行时:

| 项 | 实现方式 |
|:---:|:---:|
| 网页产物签名 | `sign-web` 子命令产出 `<文件>.sig` 与 `web_files.json` 清单 |
| 运行时校验 | 页面用内嵌根证书与 `certs/ds-chat-pages/ds-chat-pages-eec.crt` 的证书链校验全部签名 |
| 合集信任 | 引擎用内置根证书校验来源证书链,清单登记的 EEC 只是优先取用的来源 |
| 吊销检查 | `index.json` 登记 `crl` 时,网页 EEC 与合集 EEC 都按 CRL 检查吊销;离线时跳过,按吊销状态未知处理 |
| 在线与离线 | 内嵌根证书与内嵌网页签名 EEC 随构建注入,在线副本先校验再采用,失败回退内嵌 |

网页产物的签名范围、清单结构与校验流程见 [网页签名与运行时校验](web-signature.md)。

## 排错

| 现象 | 常见原因 |
|:---:|:---:|
| `openssl cms -sign` 报 `provider signature failure` | EEC 私钥是 Ed25519,必须换成 ECDSA P-256 |
| `verify-web` 报证书链校验失败 | 目录内的 `certs/ds-chat-pages/ds-chat-pages-eec.crt`(旧布局的 `eec.pem`)不是该根证书签发的,或换根后没有重新签发 |
| `sign-web` 报目标目录存在旧布局的证书 | 产物目录仍留着 `eec.pem`;删除该文件后重新运行,证书改由 certs 布局提供 |
| `verify-web` 报目录内没有 EEC 证书 | 目录内既没有 `certs/ds-chat-pages/ds-chat-pages-eec.crt`,也没有兼容回退的 `eec.pem`;重新运行 `sign-web` 生成规范路径 |
| `verify-web` 报某个文件 CMS 校验失败 | 该文件在签名后被改动过,或签名不是对当前字节生成的 |
| `verify-web` 报 `certificate revoked` | EEC 已被 `gen-crl` 吊销 |
| 生成的 `index.json` 里某个合集 `eec` 路径不对 | `certs/manifest.json` 的 `eec` 字段必须写成 `<合集 id>/<合集 id>-eec.crt` |
| 网页运行时提示证书链校验未通过 | `certs` 分支缺少 `certs/ds-chat-pages/ds-chat-pages-eec.crt`,或该证书不是当前根证书签发的 |
| 市场提示「证书已被吊销」 | 该合集的 EEC 序列号已写进 `crl.pem`,需要签发新 EEC 并重新生成 CRL,`--revoke` 只列仍需吊销的序列号 |
| 市场把整份清单判为不可信 | `crl.pem` 拉取失败、已过期、不是当前根证书签发的,或根证书 `keyUsage` 缺 `cRLSign` |
| 已安装插件显示「来源证书校验未通过」 | 来源提供的 `certs/<合集 id>/<合集 id>-eec.crt`、旧站点的扁平路径 `certs/<合集 id>-eec.crt`(或兜底的 `eec.pem`)不是由内置根证书签发,或已过期、已被吊销;需要来源换发证书 |
| 已安装插件显示「来源证书缺失」 | 信任清单登记了该来源的证书,但来源站点取不到 `certs/<合集 id>/<合集 id>-eec.crt`,扁平路径与兜底的 `eec.pem` 也不存在;需要来源补发证书,或先按记录的版本重新安装 |
| 来源已迁移到 `certs` 布局后仍提示拿不到证书 | 合集 id 与站点目录名不一致时,嵌套路径按清单登记的 id 推导;清单未登记该来源时按来源名归一化,可先用 `certs/manifest.json` 核对合集 id |
| 已安装插件显示「来源已确认」并附「未在官方清单登记」 | 证书链与验签都已通过,只是该来源未在 `trusted-manifest` 清单登记,属正常状态 |
| 市场显示「目录数据未校验」但插件仍可安装 | L1 或 L3 清单缺失、验签失败、哈希不一致,属预期的降级;产物仍由 `plugin.js.sig` 单独验证 |
| 市场提示某层清单 revision 回退 | 该层清单的 `revision` 小于本地记录值,来源可能被回滚或替换;只提示,不阻断 |
| 只发布整站签名的来源显示「目录数据未校验」但仍可安装 | 整站清单、清单签名或逐文件签名缺失,或校验未通过,属预期的降级;产物仍由 `plugin.js.sig` 单独验证 |
| 来源被识别为未确认 | 站点既没有 `manifest.json` 与 `plugins.json` 这一对特征文件,也没有 `web_files.json` 加可取到的证书;目录照常展示,结论一律为未校验 |
| 整站来源的 `plugin.js` 验签失败 | 证书取到的是别的签名者的证书,或 `plugin.js` 在签名后被改动;整站签名与合集 CMS 签名都是逐字节语义 |
| `init-root` 报不得写入仓库被追踪的路径 | 根私钥只能写到仓库外的目录或 git 忽略的临时目录 |
| 构建报缺少内嵌根证书 | `certs/ds-chat/ds-chat-root-ca.crt` 不在工作树里;离线运行必须有内嵌根证书,该文件随仓库提供 |

## 延伸阅读

- [网页签名与运行时校验](web-signature.md)
- [dsc 插件产物规范](plugin-product-spec.md)
