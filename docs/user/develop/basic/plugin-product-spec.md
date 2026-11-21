# dsc 插件产物规范

> 本文件现在只起关联与占位作用:产物与运行时规范不再在本仓库维护,以模板仓库 [dsc-plugin-template](https://github.com/omds-chat/dsc-plugin-template) 的 specs 为准。
> - [dsc 插件运行时规范](https://github.com/omds-chat/dsc-plugin-template/blob/main/specs/plugin-runtime-spec.md)
> - [dsc 插件开发规范](https://github.com/omds-chat/dsc-plugin-template/blob/main/specs/plugin-develop-spec.md)
>
> 模板仓库同时提供清单与运行时 meta 的 JSON Schema 与零依赖校验脚本。

## 已迁往模板的部分

| 主题 | 模板对应章节 |
|:---:|:---:|
| 产物形态:单文件、ESM、编码、运行位置、依赖与资源、存放与恢复 | 运行时规范 1. 产物形态 |
| 导出契约:具名 `activate`、`default` 导出、插件工厂、`manifest` 导出与优先级 | 运行时规范 2. 导出契约 |
| 清单字段与校验:`id`、`name`、`version`、`engines`、`dependencies`、`conflicts`、`capabilities`、`contributions` | 开发规范 2.1 字段与校验规则 |
| 能力分档、联网只经宿主网络能力、`net:fetch` 仅内置可见、`plugins:storage` 的存储边界与贡献点范围 | 开发规范 2.1、运行时规范 4、5.4 与 5.5 |
| 版本与兼容:三段版本、单段 `engines` 表达式、依赖与冲突按 id 判定 | 开发规范 3. 版本与依赖 |
| 加载方式的地址判定、清单优先级、跨源分发与 CORS | 运行时规范 2 与 3、开发规范 6.1 |
| 生命周期状态、能力限流与超时、上下文成员、可见数据范围 | 运行时规范 3、4、5 |
| 离线包的布局、`meta.json` 的字段规则与预检顺序 | 开发规范 4、6.2 |

## 本文保留的 dsce 专有内容

以下内容模板仓库不覆盖,仍以本仓库的实现与文档为准:

| 主题 | 为什么留在本仓库 |
|:---:|:---:|
| 合集 CMS 签名、三层清单签名、来源结论与目录数据校验 | 与 [信任链与 PKI 签名](trust-chain.md) 配套,属于本仓库的 PKI 与插件市场实现 |
| 代码体积上限 2 MB,在线与离线包共用同一上限 | 上限取值由本仓库实现界定,模板 specs 已同步记载同一上限;调整该上限时两侧需要一起改 |
| 安装记录持久化(`<APP_NAME>-plugins` 的字段集合) | 本仓库 IndexedDB 的实现细节 |
| 引擎安装接口与离线包的两步安装 | 本仓库 `dsc-plugin-engine` 的宿主接口 |
| 错误与降级的原因代码与用户可见文案 | 与本仓库的 `i18n` 文案键配套 |
| 请求前补丁(`chat:request` 与贡献点 `chat:before-request`) | 模板规范尚未覆盖,补丁字段、范围裁剪与合并规则由本仓库引擎实现界定,写入路径在 `dsc-core` 的发送路径上 |

## 引擎安装接口

| 方式 | 接口 | 说明 |
|:---:|:---:|:---:|
| 直接注册 | `engine.install(manifest, plugin)` | 宿主已持有插件对象时使用,只登记不激活 |
| 运行时加载 | `engine.installFromUrl(url, manifest?)` | 引擎自身用 `fetch` 取产物字节(安装阶段行为,不占用插件能力),按文本存进安装记录后再以 Blob 地址 `import` 加载,成功后自动激活;超时 10 秒 |
| 手动激活 | `engine.activate(id)` | 依赖满足时进入 `active` |

地址规则、清单优先级与跨源取件要求见模板仓库的运行时规范 2、3 与开发规范 6.1;取件失败的表现见本文末的错误与降级表。

## 产物签名

插件产物有两套可选的分离签名,约定见 [信任链与 PKI 签名](trust-chain.md):

| 签名 | 签发方 | 随产物分发的文件 | 验签材料 |
|:---:|:---:|:---:|:---:|
| 合集 CMS 分离签名 | 合集 EEC 证书 | `plugin.js.sig` | 清单已登记时优先用清单证书,未登记时取来源站点的 `certs/<合集 id>/<合集 id>-eec.crt`,取不到再试旧站点的扁平路径 `certs/<合集 id>-eec.crt` 与最旧的 `eec.pem`;两种来源的证书都要先过本机证书链校验 |
| 三层清单签名 | 合集 EEC 证书 | 每层的 `manifest.json.sig` | 覆盖该层目录数据的哈希,不覆盖 `plugin.js`;验签口径与产物签名一致 |
| 整站签名 | 来源的整站签名证书 | `web_files.json.sig` 与逐文件 `<文件>.sig`(含 `plugin.js.sig`) | 证书按三档取件,先用内置根证书校链,再用它验清单与文件 |
| 作者裸签名 | 插件作者 | `plugin.js.author.sig` | 合集内的 `plugins/<作者>/author_pub.pem` |

合集签名为逐字节语义,签名对象是 `plugin.js` 的原始字节,签名者是该来源的 EEC 证书;作者签名为 Ed25519 裸签名,同样直接对原始字节签名。安装与启动时两种材料都有则须同时通过,只有一种则只校验该种,都没有按未校验处理。作者签名一律是可选的:作者不提供签名材料、只提供其中一项、或验签不通过,都不阻断安装与启动。校验失败只提示,不阻断安装与启动。`meta.json` 的完整性由合集的三层哈希清单覆盖,作者不为它签名。

合集的可信性由根 CA 签发的 EEC 证书证明,信任锚是构建时内嵌的根证书:证书字节可以来自 online-data 清单登记的 `eec` 路径,也可以来自来源站点的 `certs/<合集 id>/<合集 id>-eec.crt`(旧站点的扁平路径 `certs/<合集 id>-eec.crt` 与最旧的 `eec.pem` 仅作兼容兜底),但都必须先在本机通过证书链校验;链不通过时结论为 `failed` 且不再发起 CMS 验签。清单里没有该来源只影响界面标注,不影响能否验签。

安装记录与启动恢复按同一口径给出结论:

| 结论 | 含义 | 触发条件 |
|:---:|:---:|:---:|
| `confirmed` | 来源已确认 | 证书链在本机校验通过,且 CMS 验签通过 |
| `failed` | 校验未通过 | 证书链不通过(过期、非本根签发、被吊销),或拿不到证书、验签不通过 |
| `unknown` | 无法确认来源 | 完全没有来源信息 |
| `local` | 本地安装 | 用户上传的离线包,没有来源,不参与来源判定 |

链校验失败与证书吊销是确定的负面结论,按 `failed` 处理并区分原因文案;信任清单登记了证书而证书文件缺失时,界面单列「来源证书缺失」,不落到通用的「来源校验未通过」。安装记录用 `eec_anchored` 标记证书链是否已在本机校验通过,用 `source_trust`、`trust_failure` 保存信任清单判定。旧记录按未校验处理,启动恢复时重新做链校验并重写标记;没有任何一项校验字段的旧记录(升级前安装)在已安装列表额外提示重新安装,并按记录的同一版本提供重装入口,重装后字段齐备。

### 目录数据的三层校验

合集目录数据按三层哈希清单分发,清单格式、签名与校验顺序见 [信任链与 PKI 签名](trust-chain.md)。引擎只消费 L3 清单:

| 环节 | 做法 |
|:---:|:---:|
| 安装时 | 插件市场把 L3 清单的校验结论随安装来源传入;拿到且校验通过时,安装记录记 `meta_verified`,否则记为未校验 |
| 作者公钥 | 市场把 L2 清单登记的 `author_pub.pem` 哈希一并传入;引擎按该哈希校验拉到的公钥字节,不一致时不采用该公钥,作者签名按未校验处理 |
| 产物 | `plugin.js` 仍只用 `plugin.js.sig` 验签,不依赖任何清单 |
| revision | 安装记录保存各层 `revision`;同一插件重装时若某层 `revision` 小于记录值,只给提示,不阻断安装 |

目录数据是否已校验是独立结论,不并入来源结论:来源结论仍只有 `confirmed`、`failed`、`unknown`、`local` 四态,由证书链与 CMS 验签决定;目录数据未校验不影响产物验签,也不改变来源结论。

### 只发布整站签名的来源

不是每个来源都发布三层清单。只发布整站签名的来源对站内 `.html`、`.js`、`.css`、`.json` 逐个签名,写成 `web_files.json` 并对清单自身单独签名,证书随站点分发。dsc 本体按特征文件识别来源属于哪一种模型:

| 顺序 | 探测对象 | 结论 |
|:---:|:---:|:---:|
| 1 | `manifest.json` 与 `plugins.json` 都取到 | 合集模型,目录数据按三层清单校验 |
| 2 | `web_files.json` 取到且来源证书取到 | 整站模型,目录数据按逐文件签名校验 |
| 3 | 两者都不成立 | 未确认,目录照常展示,结论一律为未校验,不报错 |

合集优先:整站模型只在合集特征文件不成立时介入,不改变合集模型的取件与结论。证书三档取件顺序与合集模型一致:

| 档 | 地址 | 说明 |
|:---:|:---:|:---:|
| 1 | `<base>/certs/<合集 id>/<合集 id>-eec.crt` | 公开发布布局;信任清单已登记时直接用清单里的证书 |
| 2 | `<base>/certs/<合集 id>-eec.crt` | 旧站点的扁平布局,只作兼容 |
| 3 | `<base>/eec.pem` | 最早的根目录布局,只发布整站签名的来源常见这一档 |

整站模型的验签顺序:取证书、用内置根证书在本机校链、用证书验 `web_files.json.sig`、按清单逐文件验签、安装与启动时按 `plugin.js.sig` 验整站签名、作者签名按材料单独校验。结论仍是三态:清单或签名缺失、证书缺失按未校验;链不通过、清单签名不通过、文件签名不通过按失败,失败只把目录数据结论降级为未校验,不阻断安装。

整站模型没有 L2 清单,安装来源里的 `authorPubSha512` 缺省,作者公钥不做哈希把关;整站模型也没有清单 `revision`,`manifest_revisions` 为空。整站签名不代替作者签名:作者签名由作者用自己持有的私钥签,合集只做收录与整站签名(或合集签名)。

## 本地离线包

本地插件由用户上传,面板一次只接受一个文件,扩展名为 `.zip` 或 `.tgz`。包内布局、`meta.json` 的字段规则与预检顺序见模板仓库的开发规范 4 与 6.2;本节保留 dsce 侧的签名规则、代码上限与安装接口。

签名规则:包内同时提供 `plugin.js.author.sig` 与 `author_pub.pem` 时按约定校验作者对 `plugin.js` 的裸公钥分离签名,校验不通过只提示,不拒绝安装,记录标记为校验失败;包内没有签名材料时同样允许安装,记录标记为未校验,界面在确认对话框中提示该插件未经签名校验。合集签名 `plugin.js.sig` 与三层哈希清单属于合集分发产物,不在离线包内校验。签名约定见 [信任链与 PKI 签名](trust-chain.md) 。

单个插件的 `plugin.js` 上限 2 MB,超出即拒绝安装,原因为 `package-too-large`:代码文本要存进 IndexedDB,异常大的产物会挤占存储配额,在线安装与本地离线包一致。

`meta.json` 的 `dependencies.dsc` 会直接当作清单的 `engines` 使用,必须写成单段版本范围,例如 `^1.0.0`、`~1.2.0`、`>=1.0.0` 或 `*`;写成 `>=1.0.0 <2.0.0` 这类组合范围时预检直接拒绝,原因为 `invalid-meta`,原因说明指向 `dependencies.dsc` 字段。

安装分两步,便于界面在中间插入二次确认:

| 接口 | 作用 |
|:---:|:---:|
| `engine.inspectLocalPackage(file)` | 解析并校验,返回待安装信息与提交函数;不改动任何状态 |
| `engine.installFromLocalFile(file)` | 预检通过后直接提交,不包含界面确认 |

同 id 已存在时拒绝安装,原因为 `duplicate`,需要先卸载。

## 安装持久化

引擎把安装记录写入 IndexedDB 的 `<APP_NAME>-plugins` 库(对象仓库 `plugins`,主键 `id`),每条包含:

| 字段 | 说明 |
|:---:|:---:|
| `manifest` | 安装时的完整清单 |
| `source_type` | `inner`、`awesome`、`outer`、`local` 之一 |
| `source_url` | 在线插件的 `plugin.js` 地址,只用于检查更新;`local` 来源留空 |
| `data_base` | 该版本目录地址,形如 `<base>/plugins/<作者>/<插件>/<版本>/`,检查更新时直接请求 |
| `plugin_base` | 插件目录地址,形如 `<base>/plugins/<作者>/<插件>/`,用于取 `versions.json` 与 `author_pub.pem` |
| `catalog_verified` | 合集根目录数据是否已按 L1 清单校验通过;旧记录没有该字段 |
| `meta_verified` | 该版本是否已按 L3 清单校验通过;旧记录没有该字段 |
| `manifest_revisions` | 各层清单 `revision`,形如 `{ "l1": 3, "l2": 2, "l3": 5 }`;重装时用于回退提示 |
| `eec` | 合集 EEC 证书 PEM,启动校验时用于 CMS 验签;清单已登记时取清单证书,未登记时依次取 `certs/<合集 id>/<合集 id>-eec.crt`、旧站点的 `certs/<合集 id>-eec.crt` 与兜底的 `eec.pem` |
| `eec_anchored` | 证书链是否已在本机校验通过;旧记录按未校验处理,启动恢复时重新校验并重写该标记 |
| `source_trust` | 信任清单判定(`trusted`、`endorsed`、`untrusted`、`unverified`),只用于界面展示;旧记录没有该字段 |
| `trust_failure` | 信任清单给出的失败原因(`missing`、`chain`、`revoked`),只用于界面展示;旧记录没有该字段 |
| `sig` | `plugin.js.sig` 的 base64 |
| `author_pub` | 作者公钥 PEM,启动校验时用于作者裸签名验签 |
| `author_sig` | 作者签名的 base64 |
| `code` | 插件代码文本,在线插件在安装时下载保存,本地插件取离线包内的 `plugin.js`;启动恢复只靠它重建模块 |
| `enabled` | 用户期望的运行状态 |
| `installed_at` | 安装时间戳 |
| `trusted` | 启动校验不通过时置为 `false`;缺省视为可信 |

四个签名字段缺失表示该记录没有对应的签名材料,启动校验按未校验处理;离线包只写 `author_pub` 与 `author_sig`,不写 `eec` 与 `sig`。

页面启动时引擎先装载内置插件,再按记录恢复外部插件:在线插件与本地插件都用记录里的 `code` 重建模块,启动阶段不访问网络;带签名材料时先对代码字节验签。加载或验签失败只把该插件标记为 `failed` 并在 `list()` 中可见,不阻塞启动与其他插件。宿主通过 `install()` 直接注册的插件没有可恢复来源,不写入该记录。

卸载插件只移除注册表与安装记录,该插件的 `plugins:storage` 数据保留;`unload()` 返回 `hasLeftoverData` 供界面提示,清理入口在设置的数据管理中。

## 错误与降级

| 情形 | 行为 |
|:---:|:---:|
| 清单非法 | 安装拒绝,原因 `invalid-manifest` |
| 能力或贡献点未知 | 安装拒绝,原因 `unknown-capability` 或 `unknown-contribution` |
| 版本不兼容 | 安装拒绝,原因 `incompatible-version` |
| 重名、缺依赖、冲突 | 安装拒绝,原因 `duplicate`、`missing-dependency`、`conflict` |
| 产物字节取不到(网络失败、跨源缺 `Access-Control-Allow-Origin`) | 安装拒绝,原因 `artifact-unreachable` |
| 产物不是可存的 UTF-8 文本 | 安装拒绝,原因 `load-failed` |
| 产物无法导入或导出不符 | 安装拒绝,原因 `load-failed` 或 `invalid-plugin` |
| 产物未导出清单且未传入清单 | 安装拒绝,原因 `invalid-manifest`,并提示 `pluginManifestMissing` |
| 离线包扩展名不是 `.zip` 或 `.tgz` | 预检拒绝,原因 `unsupported-package` |
| 离线包无法解压,或 `plugin.js` 不是合法文本 | 预检拒绝,原因 `corrupt-package` |
| 离线包缺少 `meta.json` 或 `plugin.js` | 预检拒绝,原因 `missing-meta` 或 `missing-plugin` |
| 离线包 `meta.json` 不合规,含 `dependencies.dsc` 不是单段版本范围 | 预检拒绝,原因 `invalid-meta`,原因说明指出不满足的字段 |
| 离线包作者签名校验未通过 | 不拒绝安装,记录标记为 `failed` 并提示 |
| 清单缺失、验签失败或哈希不一致 | 不拒绝安装,目录数据结论降级为未校验,产物仍按 `plugin.js.sig` 验证 |
| `author_pub.pem` 与 L2 清单登记的哈希不一致 | 不采用该公钥,作者签名按未校验处理,不影响合集 CMS 验签 |
| 某层清单 revision 小于安装记录里的值 | 只提示,不拒绝安装 |
| 离线包 `plugin.js` 超过 2 MB | 预检拒绝,原因 `package-too-large` |
| 激活抛错或超时 | 插件标记 `failed`,引擎与其他插件继续运行 |
| 未授予的能力被调用 | 抛 `PluginCapabilityError`,并提示 `pluginCapabilityDenied` |
| 未声明 `chat:before-request` 却登记请求前处理器 | 抛 `PluginCapabilityError`,并提示 `pluginCapabilityDenied` |
| 请求前补丁越界 | 按边界裁剪后生效,首次提示 `pluginRequestPatchClamped` |
| 请求前处理器超时或抛错 | 整份补丁作废,请求按原参数发出,原因写入引擎日志 |
| 超出限流 | 抛 `PluginRateLimitError`,并提示 `pluginCallRateLimited` |
| 调用超时或被取消 | 抛 `PluginTimeoutError` 或 `PluginAbortError` |
| 事件处理器抛错 | 只写入该插件日志,不影响其他处理器 |
| `net:fetch` 违反协议、方法或响应类型 | 抛 `PluginFetchError`,`reason` 为 `protocol`、`content-type` 等 |
| `net:fetch` 超时或响应体超过 512KB | 真正中止请求并抛 `PluginFetchError`,`reason` 为 `timeout` 或 `too-large` |
| 插件数据超过 64KB 或无法序列化 | 抛 `PluginDataError`,并提示 `pluginDataQuotaExceeded` 或 `pluginDataInvalid` |

所有用户可见提示复用宿主 `i18n` 文案,插件不自行拼接中文文案。
