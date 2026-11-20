# dsc-market

`dsc-market` 是 DeepSeek-Chat-Enhanced 的内置插件,负责按来源拉取插件目录、校验来源信任链、组装安装计划并上报下载计数。它不渲染界面,插件面板的「插件市场」标签页通过 `market()` 取用。

## 目录结构

```
dsc-market/
├── index.ts    # 插件对象与清单导出（activate / deactivate）
├── client.ts   # 来源解析、目录拉取、缓存、安装计划
├── model.ts    # 目录数据模型识别：合集（三层清单）与整站（web_files.json）
├── sources.ts  # 来源配置：默认值、地址校验、持久化
├── trust.ts    # 信任清单判定：是否被官方认可,不参与来源结论
├── updates.ts  # 版本更新检查：数据基址推导、版本比较、重装材料地址
├── removed.ts  # 已移除插件清单：读取、前缀匹配与三态判定
├── count.ts    # 下载计数上报
├── types.ts    # 来源、目录条目与运行态类型
└── README.md   # 机制说明
```

## 清单

| 字段 | 值 |
|:---:|:---:|
| `id` | `dsc-market` |
| `version` | `1.0.0` |
| `engines` | `^1.0.0` |
| `capabilities` | `net:fetch`、`plugins:storage` |

`net:fetch` 只对内置插件开放,因此该插件必须由 `dsc-plugin-engine` 的 `builtin.ts` 装载,作为外部插件安装会因 `unknown-capability` 被拒绝。计数请求走 `context.net.postJson`,它的能力标识是 `net:fetch-post`,由 `net:fetch` 的授予间接放行,清单不额外声明。

## 来源模型

一个来源由名称与一组 `base_url` 组成,`base_url` 按数组顺序尝试,单个请求最多等待 1 秒,失败自动切下一个。

内置来源的列表顺序即默认优先级,`dsc-inner-plugin` 在前,`awesome-dsc-plugin` 在后。

| 来源 | base_url(按优先级) |
|:---:|:---:|
| `dsc-inner-plugin` | `https://omds-chat.github.io/dsc-inner-plugin/` |
| `awesome-dsc-plugin` | `https://cdn.jsdelivr.net/gh/omds-chat/awesome-dsc-plugin@main/`、`https://raw.githubusercontent.com/omds-chat/awesome-dsc-plugin/main/`、`https://omds-chat.github.io/awesome-dsc-plugin/` |

本地开发时来源地址可由 .env 覆盖,线上地址不变: 上表的 Pages 地址在 dev 下由 .env 的 `DSC_INNER_PLUGIN_PAGES_LINK`、`AWESOME_DSC_PLUGIN_PAGES_LINK` 注入值替代,注入为空或非法时仍用线上地址,地址判定与信任校验不分开发与线上。

来源 id 与合集目录名一致,因此可以直接命中 online-data 信任清单,不必依赖公钥文本比对。旧版配置里保存的 `awesome`、`inner` 在读取时自动迁移到新 id,用户配置不会失效。来源类型仍是 `awesome`、`inner`、`outer`、`local` 四个取值: `awesome-dsc-plugin` 映射为 `awesome`,`dsc-inner-plugin` 映射为 `inner`,其余来源映射为 `outer`。

内置来源不可删除,可以改 `base_url` 列表与顺序;用户还可以新增、删除、排序自定义来源。来源配置写入 `plugins:storage` 的 `market-sources` 键,值为 `{ sources: MarketSource[] }`,结构不符时退回内置默认值。已保存的配置按用户自己的顺序读取,不因默认顺序调整而重排。界面默认选中列表第一个来源。

地址判定与引擎的插件来源判定一致:允许 `https://` 任意主机,或 `http://localhost`、`http://127.0.0.1`、`http://[::1]`。写入前统一去掉查询与哈希并补齐尾部斜杠。

## 拉取与校验流程

对每个来源依次执行:

1. 取 `<base_url>/meta.json`,解析 `DOWNLOAD_COUNT_ENABLE`、`DOWNLOAD_COUNT_API`、`API_NEED_IP`。缺失字段按关闭处理;计数地址不是合法地址时也按关闭处理。
2. 在 online-data 的 `index.json` 里按来源 id 与名称查找合集条目。找到时按该条目的 `eec` 路径拉取证书,用内置根证书校验证书链:通过记为可信,不通过或证书缺失记为不可信;清单里没有该来源时记为未登记。这一步只给出「是否被官方认可」的展示结论,来源结论由引擎按本机链校验与验签给出。
3. 取来源证书,三档顺序见下节;清单已登记时直接用清单里的那份,省一次请求。
4. 识别目录数据模型:先探测合集模型的特征文件 `manifest.json` 与 `plugins.json`,再探测整站模型的特征文件 `web_files.json` 与证书;两种都不成立时按未确认处理,不报错。见下节「目录数据的两种模型」。
5. 取 `<base_url>/plugins.json` 得到插件目录索引,每条包含 `plugin_name`、`author`、`tag`。该文件在识别模型时已取回一次,不重复请求。
6. 校验根目录材料并据此确定目录结论:合集模型取 `<base_url>/manifest.json` 与 `manifest.json.sig` 按 L1 验签,再用它校验根 `meta.json` 与 `plugins.json` 的哈希;整站模型取 `web_files.json` 与签名,先在本机校验证书链,再用证书验清单签名,最后按清单逐文件验签 `meta.json` 与 `plugins.json`。
7. 对每个插件取 `<base_url>/plugins/<author>/<plugin>/` 的校验材料并校验 `versions.json` 与该版本 `meta.json`:合集模型用 L3 清单,整站模型用这两个文件各自的 `<文件>.sig`。合集模型另取 `<base_url>/plugins/<author>/manifest.json` 按 L2 清单验签,取出 `author_pub.pem` 登记的哈希;整站模型没有 L2 清单,该哈希缺省,引擎按未校验作者公钥哈希处理。拿到 `versions.json` 的 `latest` 后取该版本 `meta.json` 作为展示信息。
8. 安装时用 `<base_url>/plugins/<author>/<plugin>/<latest>/plugin.js` 作为产物地址,并把该版本目录 `dataBase` 与插件目录 `pluginBase` 一并交给引擎入库,后续检查更新直接按 `dataBase` 请求,不必再从 `plugins.json` 反查。目录数据结论与各层 revision 随安装来源交给引擎(整站模型没有清单 revision,该字段为空)。签名材料的地址同样交给引擎:合集证书有两个来源,清单已登记时把 `eec` 一起交给引擎(优先使用,省一次请求),同时给出 `eecUrls` 即来源自带的地址列表,按顺序为 `<base_url>/certs/<合集 id>/<合集 id>-eec.crt`、`<base_url>/certs/<合集 id>-eec.crt` 与兜底的 `<base_url>/eec.pem`(嵌套布局是当前公开发布布局,扁平路径只在旧站点存在、留作兼容,`eec.pem` 最后兜底);引擎先用内置根 CA 校验证书链,通过后才验签,链不通过时结论为 `failed` 且不发起 CMS 验签。CMS 签名取同版本目录的 `plugin.js.sig`,作者签名取 `plugin.js.author.sig` 与 `plugins/<author>/author_pub.pem`。

合集的可信性由「根 CA 签发的 EEC」证明,没有额外的合集信任签名(旧结构见 [信任链与 PKI 签名](../../../docs/user/develop/basic/trust-chain.md))。同一个来源的信任材料必须同址取用,避免把 A 地址的签名与 B 地址的证书拼在一起。

### 三层清单校验

合集目录数据按三层哈希清单分发,清单格式、签名与校验顺序见 [信任链与 PKI 签名](../../../docs/user/develop/basic/trust-chain.md);客户端实现是 `src/services/integrity/manifest.ts`。

| 层 | 取用位置 | 校验对象 |
|:---:|:---:|:---:|
| L1 | `<base_url>/manifest.json` | 根 `meta.json`、`plugins.json` |
| L2 | `<base_url>/plugins/<author>/manifest.json` | `author_pub.pem` 的哈希,交给引擎把关作者公钥 |
| L3 | `<base_url>/plugins/<author>/<plugin>/manifest.json` | `versions.json` 与展示版本的 `meta.json` |

`manifest.json.sig` 是 CMS 的 DER 二进制,按字节读取;目录数据文件仍经 `net` 能力按文本读取,哈希按还原后的 UTF-8 字节计算。清单缺失、验签失败或哈希不一致都不阻断:目录照常展示,该来源标记为「目录数据未校验」,该插件标记为未校验,产物仍由 `plugin.js.sig` 单独验证。

每层路径记住见过的最大 `revision`,写在 `plugins:storage` 的 `manifest-revisions` 键下。本次拿到的 `revision` 小于记录值时,来源运行态多出一条 `revisionWarnings`,界面按提示展示,只警告不阻断。

### 目录数据的两种模型

同一份目录数据(`meta.json`、`plugins.json`、`plugins/<author>/...`)有两种签名组织方式,市场按特征文件识别当前来源属于哪一种:

| 模型 | 特征文件 | 目录数据的签名材料 |
|:---:|:---:|:---:|
| 合集模型 | `<base_url>/manifest.json` 与 `<base_url>/plugins.json` | 三层哈希清单,每层一份 `manifest.json.sig` |
| 整站模型 | `<base_url>/web_files.json` 与来源证书 | `web_files.json.sig` 加逐文件 `<文件>.sig` |
| 未确认 | 两种特征文件都不成立 | 无,目录照常展示,结论一律为未校验 |

识别顺序固定:先探测合集模型的两个特征文件,都取到即按合集处理,不再看整站特征文件;其次探测 `web_files.json` 且来源证书已取到即按整站处理;其余情形按未确认处理,不报错、不写 `error`,目录照常展示。识别结果写在来源运行态的 `model` 字段,取值 `collection`、`site`、`unknown`。

合集优先是硬约束:整站模型不改变合集模型的取件、验签与结论,只在合集特征文件不成立时介入。整站模型与未确认模型都不产生清单 revision,也不产生 revision 回退提示。

### 整站模型(web_files.json 与逐文件签名)

整站模型用一份整站清单加逐文件签名覆盖站内的 `.html`、`.js`、`.css`、`.json`,常见于只发布整站签名的来源。验签顺序:

| 顺序 | 做法 |
|:---:|:---:|
| 1 | 取证书:信任清单已登记时用清单里那份,未登记时按下面的三档取件 |
| 2 | 用构建内嵌的根证书在本机校验证书链,链不通过即失败,且不再发起 CMS 验签 |
| 3 | 用证书验 `<base_url>/web_files.json` 的签名 `web_files.json.sig` |
| 4 | 按清单逐文件验签本次实际消费的文件;文件不在清单内按失败处理,签名文件缺失按未校验处理 |
| 5 | 插件产物 `plugin.js` 的整站签名由引擎按 `plugin.js.sig` 与同一份证书验签,与合集模型的产物验签走同一条通道 |
| 6 | 作者签名 `plugin.js.author.sig` 是可选材料,失败只警告;整站模型没有 L2 清单,作者公钥哈希缺省 |

签名结论只有三态:通过、未校验、失败。清单或签名缺失、没有证书、环境不具备校验条件按未校验处理;证书链不通过、清单签名不通过、文件签名不通过按失败处理。失败只把 `catalogVerified` 与 `metaVerified` 置为否,不写 `error`、不阻断浏览与安装,与合集模型的口径一致。

逐文件验签的对象是市场已取到的那份字节,不重新取件,避免验签内容与实际消费内容不一致。整站清单只在首次消费时验签一次,结论在同一次目录拉取内复用。

证书三档取件顺序(两种模型共用):

| 档 | 地址 | 说明 |
|:---:|:---:|:---:|
| 1 | `<base_url>/certs/<合集 id>/<合集 id>-eec.crt` | 公开发布布局;信任清单已登记时直接用清单里的证书,跳过这一档 |
| 2 | `<base_url>/certs/<合集 id>-eec.crt` | 旧站点的扁平布局,只作兼容 |
| 3 | `<base_url>/eec.pem` | 最早的根目录布局,只发布整站签名的来源常见这一档 |

三档都由引擎先用内置根 CA 校验证书链,链不通过时不发起 CMS 验签;三档都取不到才算拿不到证书,此时按未校验处理。

## 信任状态

| 状态 | 判定 | 界面行为 |
|:---:|:---:|:---:|
| `trusted` | 信任清单里该来源的 EEC 证书链校验通过 | 允许浏览与安装 |
| `endorsed` | 来源由 dsc 直接背书,即内置的 `dsc-inner-plugin` 内部插件索引;信任清单里登记了它的 EEC 时仍按证书链校验,两种判定都通过才记为背书,链校验不通过仍记为不可信 | 显示「dsc 官方维护」标识,与社区合集的「可信」区分;安装与验签流程与其他来源完全一致,不跳过任何校验 |
| `untrusted` | 清单里有该来源,但证书链校验不通过或证书文件缺失 | 仍列出目录并保留「不可信」标识与警告;安装仍可进行,第一次点击转为 3 秒确认态 |
| `unverified` | online-data 信任清单里没有该来源,或构建未注入根证书 `__ROOT_CA_PEM__` | 中性标注「未在官方清单登记」;安装前仍需二次确认,不按不可信处理 |

`dsc-inner-plugin` 是 dsc 直接签名的内部插件索引,由 dsc 背书而不是由合集 EEC 链证明,因此单列 `endorsed` 状态。背书来源仍走与外部来源相同的安装通道：验签、落库与启动校验全部由 `dsc-plugin-engine` 完成,市场侧不为 inner 提供任何跳过校验的分支。用户自建的来源即使 id 与内部索引相同也不按背书处理,`isEndorsedSource` 要求来源是内置来源。

### 来源结论

安装计划与安装记录按同一口径描述来源结论,判定只看本机结论: 证书链通过且 CMS 验签通过才算已确认。

| 结论 | 含义 | 触发条件 |
|:---:|:---:|:---:|
| `confirmed` | 来源已确认 | 证书链在本机校验通过,且 CMS 验签通过 |
| `failed` | 校验未通过 | 证书链不通过(过期、非本根签发、被吊销),或拿不到证书、验签不通过 |
| `unknown` | 无法确认来源 | 完全没有来源信息 |
| `local` | 本地安装 | 用户上传的离线包,没有来源,不参与来源判定 |

目录数据是否已校验是独立结论,用 `catalogVerified` 表示,不并入来源结论:来源运行态与安装计划各带一份,前者是根目录材料的结论(合集模型为 L1 清单,整站模型为整站清单加根目录两个文件),后者再与插件目录材料的结论(合集模型为 L3 清单,整站模型为该插件两个文件的签名)取合取。目录未校验时来源结论不变,产物仍按 `plugin.js.sig` 判定。整站签名与作者签名是两条独立路径,整站签名不代替作者签名。

安装计划同时给出两个证书来源: 清单已登记时带 `eec`(优先使用,省一次请求),任何在线来源都带 `eecUrls`,按顺序为嵌套的 `<base_url>/certs/<合集 id>/<合集 id>-eec.crt`、旧站点的扁平路径 `<base_url>/certs/<合集 id>-eec.crt` 与兜底的 `<base_url>/eec.pem`。两种证书都必须由引擎先用内置根 CA 校验链,链不通过时结论为 `failed` 且不发起 CMS 验签,安装记录以 `eec_anchored` 记为未通过链校验。市场把运行态的 `trust` 与 `trustFailure` 一并交给引擎,但只用于界面展示来源是否被官方认可,不参与来源结论判定。

信任锚 `__ROOT_CA_PEM__` 由 `rspack.config.ts` 在构建时从 `certs/ds-chat/ds-chat-root-ca.crt` 注入。信任清单里的同名根证书(`certs/ds-chat/ds-chat-root-ca.crt`)只用于比对,与内嵌根证书不一致时以构建内置的为准,并在控制台留一条提示。

## 已移除插件清单

合集站点可以发布一份已移除插件清单,位置固定为 `<base_url>/catalog/removed.json`,用于在用户直接粘贴产物链接安装失败时区分「曾经存在、后来移除」与「从未存在」:

| 字段 | 说明 |
|:---:|:---:|
| `schemaVersion` | 清单结构版本,当前为 `1`;其它版本按不可读处理 |
| `removed` | 条目数组 |
| `removed[].name` | 插件名,用于提示里点名 |
| `removed[].base_url` | 该插件原先分发的站点基址,允许同一插件登记多个地址 |
| `removed[].removed_in` | 移除时的插件版本号 |
| `removed[].note` | 可选说明,可写单语字符串或 `{"zh-CN":"…","en-US":"…"}` 双语对象 |

判定方式:取所有已配置来源的全部 `base_url`,并发请求各自的清单,单个请求短超时(1 秒),请求失败与结构不符都静默跳过;把用户的产物链接与各条目的 `base_url` 做前缀匹配,两侧都先去掉查询与哈希并补齐基址尾部斜杠,多条命中时取最长基址。结论三态:

| 结论 | 条件 | 界面表现 |
|:---:|:---:|:---:|
| 已移除 | 命中任一条目 | 提示该插件已不再受该来源支持,建议关注其他来源;不删除本地安装记录与插件数据 |
| 不存在 | 至少一份清单可达但未命中 | 沿用「找不到这个插件」的提示 |
| 未判定 | 清单全部不可达,或市场尚未就绪 | 沿用原有安装失败提示,不作判断 |

只有「取不到产物」这一类失败才触发判定,签名校验不通过等其他失败原因不查询清单。判定全程只读:只发 GET 文本请求,不写来源配置、安装记录与插件数据。判定逻辑在 `removed.ts`,由客户端以 `checkRemoved()` 暴露,界面通过 `market()?.checkRemoved(url)` 取用。

## 版本更新检查

已安装列表对每个来自在线来源的插件做一次版本比对：

| 环节 | 做法 |
|:---:|:---:|
| 数据基址 | 优先取安装记录里的 `dataBase`;旧记录没有该字段时,由 `source_url` 去掉 `plugin.js` 得到版本目录 |
| 最新版本 | 请求版本目录上一级的 `versions.json`,取其中的 `latest` |
| 判定 | 本地 `manifest.version` 落后为「可更新」,相同或更高为「已是最新」,版本号不合法或没有来源时不显示任何标注 |
| 请求约束 | 单个请求超时 1 秒,并发上限 4,失败静默;结果按插件目录缓存 5 分钟 |

「可更新」是强提示,点击后按钮转为 3 秒确认态,确认后由 `reinstallPlan` 生成重新安装计划：产物与签名材料地址按已安装记录的版本目录推导,证书地址按来源根目录推导为 `certs/<合集 id>/<合集 id>-eec.crt`、旧站点的扁平路径 `certs/<合集 id>-eec.crt` 与兜底的 `eec.pem`,清单已登记时优先用清单证书,两种证书都要过链校验。引擎没有覆盖安装入口,因此界面先卸载旧记录再按最新版重新安装;新版本安装失败时按记录里的版本回滚。同一路径也用于旧版本安装的记录: 这类记录没有任何校验字段,来源结论只能是「来源未确认」,已安装列表在结论旁补一条提示并给出「重新安装」,点击后按记录里的同一版本走上面的流程。

## 下载计数

来源的 `meta.json` 中 `DOWNLOAD_COUNT_ENABLE` 为真且 `DOWNLOAD_COUNT_API` 为合法地址时,每次安装成功都会向该地址发一次 POST:

| 字段 | 说明 |
|:---:|:---:|
| `plugin` | 插件名称 |
| `time` | 请求发送时间,ISO 8601 |

请求不等待响应,失败静默,不阻塞安装。

客户端不上报 IP。`API_NEED_IP` 为真表示该来源会记录请求来源 IP,由接收方从请求来源自行获取;客户端既不查询也不携带公网 IP,因此计数链路不产生任何第三方请求。该字段只用于界面提示,让用户知情。

启用计数的来源在来源列表显示「下载计数」标识,并在目录上方给出说明;`API_NEED_IP` 为真时额外提示「该来源会记录请求来源 IP」。

## 界面结构

插件面板的「插件市场」标签页由 `src/components/plugins/MarketPlugins.tsx` 渲染:

| 区域 | 内容 |
|:---:|:---:|
| 顶部 | 来源列表:名称、当前生效的 `base_url`、信任状态、下载计数标识、刷新、编辑、排序与删除;新增来源表单 |
| 主体 | 选中来源的插件目录:插件名、作者、标签、最新版本、简介(来自该版本的 `meta.json`)与安装按钮 |

来源不可信或未在清单登记时,安装按钮第一次点击转为 3 秒确认态,确认后才调用引擎;不可信来源额外显示「不可信」标识与警告文案。目录上方的来源文案只反映清单结论: 判定为不可信时按原因显示「来源证书校验未通过」或「来源证书已被吊销」,未在清单登记时显示中性标注「未在官方清单登记」。来源结论「来源已确认」出现在已安装插件列表,由引擎按本机链校验与验签给出;已确认但未在清单登记时,列表额外补一条同样的中性标注;信任清单登记了证书但证书文件缺失时,列表显示「来源证书缺失」而不是通用文案。

## 对外接口

```ts
import { market } from '../dsc-market/index.js'

const client = market()
client?.sources()              // 来源列表
client?.runtime('awesome-dsc-plugin') // 来源运行态:state、baseUrl、trust、model、eecFromTrustList、meta、plugins
client?.selected()             // 当前选中的来源 id
client?.select('awesome-dsc-plugin')
await client?.refresh('awesome-dsc-plugin', true)  // 拉取并校验;force 为 true 时忽略缓存
client?.addSource('自定义', ['https://example.com/plugins/'])
client?.setBaseUrls('awesome-dsc-plugin', ['https://cdn.example.com/'])
client?.moveSource('dsc-inner-plugin', -1)
client?.removeSource('custom-3')        // 内置来源与最后一个来源不可删除
client?.plan('awesome-dsc-plugin', plugin)         // 安装计划:{ url, manifest?, sourceType, eec?, eecUrls, sigUrl, authorPubUrl, authorSigUrl, catalogVerified, metaVerified, revisions, authorPubSha512? };eec 是清单证书(已登记时优先),eecUrls 是来源证书地址列表(嵌套路径优先,旧站点的扁平路径兼容,最旧的 eec.pem 兜底),revisions 是三层清单的 revision,authorPubSha512 来自 L2 清单
client?.countInstall('awesome-dsc-plugin', plugin) // 上报一次下载计数
await client?.checkUpdates([{ id: 'demo', version: '1.0.0', sourceUrl: 'https://example.com/plugins/a/demo/1.0.0/plugin.js' }]) // 更新检查：Map<id, { status: 'outdated' | 'latest', latest }>
client?.reinstallPlan(target, '1.1.0')  // 重新安装计划：{ plan, trust, trustFailure }，地址结构不符时为 null
await client?.checkRemoved('https://example.com/plugins/a/demo/1.0.0/plugin.js') // 已移除插件判定：removed | absent | undetermined
```

异步接口是 `refresh`、`checkUpdates` 与 `checkRemoved`，其余都是同步快照。界面用 `subscribe` 与 `version` 配合 `useSyncExternalStore` 订阅状态变化。

## 缓存与失败处理

| 情形 | 行为 |
|:---:|:---:|
| 目录已拉取且未超过 5 分钟 | 直接返回内存结果,不发起请求 |
| 某个 `base_url` 超时或失败 | 切下一个 `base_url` |
| 全部 `base_url` 失败 | 来源状态 `failed`,提示该来源所有地址都拉取失败 |
| `plugins.json` 结构不符 | 目录为空并提示插件目录索引拉取失败 |
| 单个插件 `versions.json` 或 `meta.json` 失败 | 该行标记失败原因,其余插件不受影响 |
| L1 清单缺失、验签失败或哈希不一致 | 目录照常展示,该来源标记为「目录数据未校验」 |
| L3 清单缺失、验签失败或哈希不一致 | 该插件标记为未校验,其余插件不受影响 |
| 整站清单缺失、验签失败或逐文件验签不通过 | 目录照常展示,该来源标记为「目录数据未校验」,不写失败原因 |
| 某层清单 revision 小于本地记录值 | 来源运行态追加一条回退提示,只警告不阻断 |
| 两种模型的特征文件都不成立 | 目录照常展示,结论一律为未校验,不发警告、不报错 |
| 结构不符的目录条目 | 跳过并计入 `skipped` |
| 更新检查的 `versions.json` 未超过 5 分钟 | 复用缓存的最新版本号 |
| 更新检查的请求超时或失败 | 该插件不显示任何更新标注 |

目录缓存只在内存中,不写入 `plugins:storage`,避免 64KB 配额被大目录挤占。
