# dsc-market

`dsc-market` 是 dsc 的内置插件,负责按来源拉取插件目录、校验来源信任链、组装安装计划并上报下载计数。它不渲染界面,插件面板的「插件市场」标签页通过 `market()` 取用。

## 目录结构

```
dsc-market/
├── index.ts    # 插件对象与清单导出（activate / deactivate）
├── client.ts   # 来源解析、目录拉取、缓存、安装计划
├── sources.ts  # 来源配置：默认值、地址校验、持久化
├── trust.ts    # 信任判定：按 online-data 信任清单校验合集 EEC 证书链
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

内置来源的列表顺序即默认优先级，`dsc-inner-plugin` 在前，`awesome-dsc-plugin` 在后。

| 来源 | base_url（按优先级） |
|:---:|:---:|
| `dsc-inner-plugin` | `https://omdsc-dev.github.io/dsc-inner-plugin/` |
| `awesome-dsc-plugin` | `https://cdn.jsdelivr.net/gh/omdsc-dev/awesome-dsc-plugin@main/`、`https://raw.githubusercontent.com/omdsc-dev/awesome-dsc-plugin/main/`、`https://omdsc-dev.github.io/awesome-dsc-plugin/` |

来源 id 与合集目录名一致,因此可以直接命中 online-data 信任清单,不必依赖公钥文本比对。旧版配置里保存的 `awesome`、`inner` 在读取时自动迁移到新 id,用户配置不会失效。来源类型仍是 `awesome`、`inner`、`outer`、`local` 四个取值: `awesome-dsc-plugin` 映射为 `awesome`,`dsc-inner-plugin` 映射为 `inner`,其余来源映射为 `outer`。

两个内置来源不可删除,可以改 `base_url` 列表与顺序;用户还可以新增、删除、排序自定义来源。来源配置写入 `plugins:storage` 的 `market-sources` 键,值为 `{ sources: MarketSource[] }`,结构不符时退回内置默认值。已保存的配置按用户自己的顺序读取,不因默认顺序调整而重排。界面默认选中列表第一个来源。

地址判定与引擎的插件来源判定一致:允许 `https://` 任意主机,或 `http://localhost`、`http://127.0.0.1`、`http://[::1]`。写入前统一去掉查询与哈希并补齐尾部斜杠。

## 拉取与校验流程

对每个来源依次执行:

1. 取 `<base_url>/meta.json`,解析 `DOWNLOAD_COUNT_ENABLE`、`DOWNLOAD_COUNT_API`、`API_NEED_IP`。缺失字段按关闭处理;计数地址不是合法地址时也按关闭处理。
2. 在 online-data 的 `index.json` 里按来源 id 与名称查找合集条目。找到时按该条目的 `eec` 路径拉取证书,用 `root_ca.crt` 校验证书链:通过记为可信,不通过或证书缺失记为不可信;清单里没有该来源时记为未校验。
3. 取 `<base_url>/datalog.json` 得到插件目录,每条包含 `plugin_name`、`author`、`tag`。
4. 对每个插件取 `<base_url>/plugins/<author>/<plugin>/versions.json` 得到 `latest` 与版本列表,再取 `<base_url>/plugins/<author>/<plugin>/<latest>/meta.json` 作为展示信息。
5. 安装时用 `<base_url>/plugins/<author>/<plugin>/<latest>/plugin.js` 作为产物地址,把签名材料的地址交给引擎:合集证书在来源可信时取信任清单里的 `eec` 证书,否则交给引擎拉取 `<base_url>/eec.pem`;CMS 签名取同版本目录的 `plugin.js.sig`,作者签名取 `plugin.js.author.sig` 与 `plugins/<author>/author_pub.pem`。

合集的可信性由「根 CA 签发的 EEC」证明,来源不再提供 `plugin_set_sign.json` 一类的信任签名。同一个来源的信任材料必须同址取用,避免把 A 地址的签名与 B 地址的证书拼在一起。

## 信任状态

| 状态 | 判定 | 界面行为 |
|:---:|:---:|:---:|
| `trusted` | 信任清单里该来源的 EEC 证书链校验通过 | 允许浏览与安装 |
| `untrusted` | 清单里有该来源,但证书链校验不通过或证书文件缺失 | 仍列出目录并保留「不可信」标识与警告;安装仍可进行,第一次点击转为 3 秒确认态 |
| `unverified` | online-data 信任清单里没有该来源,或构建未注入根证书 `__ROOT_CA_PEM__` | 允许浏览;安装前需要用户二次确认风险 |

信任锚 `__ROOT_CA_PEM__` 由 `rspack.config.ts` 在构建时注入。信任清单里的 `root_ca.crt` 必须与内嵌根证书逐字一致,否则整份清单不被采信,所有来源按未校验处理;这可以避免镜像方自带根证书自签 EEC。

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
| 主体 | 选中来源的插件目录:插件名、作者、标签、最新版本、简介（来自该版本的 `meta.json`）与安装按钮 |

来源不可信与信任未校验时,安装按钮第一次点击转为 3 秒确认态,确认后才调用引擎;不可信来源额外显示「不可信」标识与警告文案。证书取自 online-data 信任清单时,目录上方显示「证书来自 online-data 信任清单」。

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
client?.plan('awesome-dsc-plugin', plugin)         // 安装计划:{ url, manifest?, sourceType, eec?, eecUrl?, sigUrl, authorPubUrl, authorSigUrl }
client?.countInstall('awesome-dsc-plugin', plugin) // 上报一次下载计数
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
| 结构不符的目录条目 | 跳过并计入 `skipped` |

目录缓存只在内存中,不写入 `plugins:storage`,避免 64KB 配额被大目录挤占。
