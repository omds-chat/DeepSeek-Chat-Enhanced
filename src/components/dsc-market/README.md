# dsc-market

`dsc-market` 是 dsc 的内置插件,负责按来源拉取插件目录、校验来源信任链、组装安装计划并上报下载计数。它不渲染界面,插件面板的「插件市场」标签页通过 `market()` 取用。

## 目录结构

```
dsc-market/
├── index.ts    # 插件对象与清单导出（activate / deactivate）
├── client.ts   # 来源解析、目录拉取、缓存、安装计划
├── sources.ts  # 来源配置：默认值、地址校验、持久化
├── trust.ts    # 信任清单判定：是否被官方认可,不参与来源结论
├── updates.ts  # 版本更新检查：数据基址推导、版本比较、重装材料地址
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
| `dsc-inner-plugin` | `https://omdsc-dev.github.io/dsc-inner-plugin/` |
| `awesome-dsc-plugin` | `https://cdn.jsdelivr.net/gh/omdsc-dev/awesome-dsc-plugin@main/`、`https://raw.githubusercontent.com/omdsc-dev/awesome-dsc-plugin/main/`、`https://omdsc-dev.github.io/awesome-dsc-plugin/` |

来源 id 与合集目录名一致,因此可以直接命中 online-data 信任清单,不必依赖公钥文本比对。旧版配置里保存的 `awesome`、`inner` 在读取时自动迁移到新 id,用户配置不会失效。来源类型仍是 `awesome`、`inner`、`outer`、`local` 四个取值: `awesome-dsc-plugin` 映射为 `awesome`,`dsc-inner-plugin` 映射为 `inner`,其余来源映射为 `outer`。

内置来源不可删除,可以改 `base_url` 列表与顺序;用户还可以新增、删除、排序自定义来源。来源配置写入 `plugins:storage` 的 `market-sources` 键,值为 `{ sources: MarketSource[] }`,结构不符时退回内置默认值。已保存的配置按用户自己的顺序读取,不因默认顺序调整而重排。界面默认选中列表第一个来源。

地址判定与引擎的插件来源判定一致:允许 `https://` 任意主机,或 `http://localhost`、`http://127.0.0.1`、`http://[::1]`。写入前统一去掉查询与哈希并补齐尾部斜杠。

## 拉取与校验流程

对每个来源依次执行:

1. 取 `<base_url>/meta.json`,解析 `DOWNLOAD_COUNT_ENABLE`、`DOWNLOAD_COUNT_API`、`API_NEED_IP`。缺失字段按关闭处理;计数地址不是合法地址时也按关闭处理。
2. 在 online-data 的 `index.json` 里按来源 id 与名称查找合集条目。找到时按该条目的 `eec` 路径拉取证书,用内置根证书校验证书链:通过记为可信,不通过或证书缺失记为不可信;清单里没有该来源时记为未登记。这一步只给出「是否被官方认可」的展示结论,来源结论由引擎按本机链校验与验签给出。
3. 取 `<base_url>/manifest.json` 与 `manifest.json.sig`,按 L1 清单验签,再用它校验根 `meta.json` 与 `datalog.json` 的哈希。
4. 取 `<base_url>/datalog.json` 得到插件目录,每条包含 `plugin_name`、`author`、`tag`。
5. 对每个插件取 `<base_url>/plugins/<author>/<plugin>/manifest.json` 与签名,按 L3 清单验签,再用它校验 `versions.json` 与该版本 `meta.json` 的哈希;同时取 `<base_url>/plugins/<author>/manifest.json` 按 L2 清单验签,取出 `author_pub.pem` 登记的哈希。拿到 `versions.json` 的 `latest` 后取该版本 `meta.json` 作为展示信息。
6. 安装时用 `<base_url>/plugins/<author>/<plugin>/<latest>/plugin.js` 作为产物地址,并把该版本目录 `dataBase` 与插件目录 `pluginBase` 一并交给引擎入库,后续检查更新直接按 `dataBase` 请求,不必再从 `datalog.json` 反查。三层清单的结论与各层 revision 随安装来源交给引擎。签名材料的地址同样交给引擎:合集证书有两个来源,清单已登记时把 `eec` 一起交给引擎(优先使用,省一次请求),同时给出 `eecUrl` 即来源自带的 `<base_url>/eec.pem`;引擎先用内置根 CA 校验证书链,通过后才验签,链不通过时结论为 `failed` 且不发起 CMS 验签。CMS 签名取同版本目录的 `plugin.js.sig`,作者签名取 `plugin.js.author.sig` 与 `plugins/<author>/author_pub.pem`。

合集的可信性由「根 CA 签发的 EEC」证明,没有额外的合集信任签名(旧结构见 [信任链与 PKI 签名](../../../docs/user/develop/basic/trust-chain.md))。同一个来源的信任材料必须同址取用,避免把 A 地址的签名与 B 地址的证书拼在一起。

### 三层清单校验

合集目录数据按三层哈希清单分发,清单格式、签名与校验顺序见 [信任链与 PKI 签名](../../../docs/user/develop/basic/trust-chain.md);客户端实现是 `src/services/integrity/manifest.ts`。

| 层 | 取用位置 | 校验对象 |
|:---:|:---:|:---:|
| L1 | `<base_url>/manifest.json` | 根 `meta.json`、`datalog.json` |
| L2 | `<base_url>/plugins/<author>/manifest.json` | `author_pub.pem` 的哈希,交给引擎把关作者公钥 |
| L3 | `<base_url>/plugins/<author>/<plugin>/manifest.json` | `versions.json` 与展示版本的 `meta.json` |

`manifest.json.sig` 是 CMS 的 DER 二进制,按字节读取;目录数据文件仍经 `net` 能力按文本读取,哈希按还原后的 UTF-8 字节计算。清单缺失、验签失败或哈希不一致都不阻断:目录照常展示,该来源标记为「目录数据未校验」,该插件标记为未校验,产物仍由 `plugin.js.sig` 单独验证。

每层路径记住见过的最大 `revision`,写在 `plugins:storage` 的 `manifest-revisions` 键下。本次拿到的 `revision` 小于记录值时,来源运行态多出一条 `revisionWarnings`,界面按提示展示,只警告不阻断。

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

目录数据是否已校验是独立结论,用 `catalogVerified` 表示,不并入来源结论:来源运行态与安装计划各带一份,前者是 L1 结论,后者是 L1 与 L3 结论的合取。目录未校验时来源结论不变,产物仍按 `plugin.js.sig` 判定。

安装计划同时给出两个证书来源: 清单已登记时带 `eec`(优先使用,省一次请求),任何在线来源都带 `eecUrl` 即 `<base_url>/eec.pem`。两种证书都必须由引擎先用内置根 CA 校验链,链不通过时结论为 `failed` 且不发起 CMS 验签,安装记录以 `eec_anchored` 记为未通过链校验。市场把运行态的 `trust` 与 `trustFailure` 一并交给引擎,但只用于界面展示来源是否被官方认可,不参与来源结论判定。

信任锚 `__ROOT_CA_PEM__` 由 `rspack.config.ts` 在构建时从 `certs/dsce/root-ca/dsce-root-ca.crt` 注入。信任清单里的同名根证书(`certs/dsce/root-ca/dsce-root-ca.crt`)只用于比对,与内嵌根证书不一致时以构建内置的为准,并在控制台留一条提示。

## 版本更新检查

已安装列表对每个来自在线来源的插件做一次版本比对：

| 环节 | 做法 |
|:---:|:---:|
| 数据基址 | 优先取安装记录里的 `dataBase`;旧记录没有该字段时,由 `source_url` 去掉 `plugin.js` 得到版本目录 |
| 最新版本 | 请求版本目录上一级的 `versions.json`,取其中的 `latest` |
| 判定 | 本地 `manifest.version` 落后为「可更新」,相同或更高为「已是最新」,版本号不合法或没有来源时不显示任何标注 |
| 请求约束 | 单个请求超时 1 秒,并发上限 4,失败静默;结果按插件目录缓存 5 分钟 |

「可更新」是强提示,点击后按钮转为 3 秒确认态,确认后由 `reinstallPlan` 生成重新安装计划：产物与签名材料地址按已安装记录的版本目录推导,证书地址按来源根目录推导为 `eec.pem`,清单已登记时优先用清单证书,两种证书都要过链校验。引擎没有覆盖安装入口,因此界面先卸载旧记录再按最新版重新安装;新版本安装失败时按记录里的版本回滚。

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

来源不可信或未在清单登记时,安装按钮第一次点击转为 3 秒确认态,确认后才调用引擎;不可信来源额外显示「不可信」标识与警告文案。目录上方的来源文案只反映清单结论: 判定为不可信时按原因显示「来源证书校验未通过」或「来源证书已被吊销」,未在清单登记时显示中性标注「未在官方清单登记」。来源结论「来源已确认」出现在已安装插件列表,由引擎按本机链校验与验签给出;已确认但未在清单登记时,列表额外补一条同样的中性标注。

## 对外接口

```ts
import { market } from '../dsc-market/index.js'

const client = market()
client?.sources()              // 来源列表
client?.runtime('awesome-dsc-plugin') // 来源运行态:state、baseUrl、trust、eecFromTrustList、meta、plugins
client?.selected()             // 当前选中的来源 id
client?.select('awesome-dsc-plugin')
await client?.refresh('awesome-dsc-plugin', true)  // 拉取并校验;force 为 true 时忽略缓存
client?.addSource('自定义', ['https://example.com/plugins/'])
client?.setBaseUrls('awesome-dsc-plugin', ['https://cdn.example.com/'])
client?.moveSource('dsc-inner-plugin', -1)
client?.removeSource('custom-3')        // 内置来源与最后一个来源不可删除
client?.plan('awesome-dsc-plugin', plugin)         // 安装计划:{ url, manifest?, sourceType, eec?, eecUrl, sigUrl, authorPubUrl, authorSigUrl, catalogVerified, metaVerified, revisions, authorPubSha512? };eec 是清单证书(已登记时优先),eecUrl 是来源的 eec.pem,revisions 是三层清单的 revision,authorPubSha512 来自 L2 清单
client?.countInstall('awesome-dsc-plugin', plugin) // 上报一次下载计数
await client?.checkUpdates([{ id: 'demo', version: '1.0.0', sourceUrl: 'https://example.com/plugins/a/demo/1.0.0/plugin.js' }]) // 更新检查：Map<id, { status: 'outdated' | 'latest', latest }>
client?.reinstallPlan(target, '1.1.0')  // 重新安装计划：{ plan, trust, trustFailure }，地址结构不符时为 null
```

`refresh`、`plan`、`countInstall` 之外的接口都是同步快照。界面用 `subscribe` 与 `version` 配合 `useSyncExternalStore` 订阅状态变化。

## 缓存与失败处理

| 情形 | 行为 |
|:---:|:---:|
| 目录已拉取且未超过 5 分钟 | 直接返回内存结果,不发起请求 |
| 某个 `base_url` 超时或失败 | 切下一个 `base_url` |
| 全部 `base_url` 失败 | 来源状态 `failed`,提示该来源所有地址都拉取失败 |
| `datalog.json` 结构不符 | 目录为空并提示插件目录拉取失败 |
| 单个插件 `versions.json` 或 `meta.json` 失败 | 该行标记失败原因,其余插件不受影响 |
| L1 清单缺失、验签失败或哈希不一致 | 目录照常展示,该来源标记为「目录数据未校验」 |
| L3 清单缺失、验签失败或哈希不一致 | 该插件标记为未校验,其余插件不受影响 |
| 某层清单 revision 小于本地记录值 | 来源运行态追加一条回退提示,只警告不阻断 |
| 结构不符的目录条目 | 跳过并计入 `skipped` |
| 更新检查的 `versions.json` 未超过 5 分钟 | 复用缓存的最新版本号 |
| 更新检查的请求超时或失败 | 该插件不显示任何更新标注 |

目录缓存只在内存中,不写入 `plugins:storage`,避免 64KB 配额被大目录挤占。
