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
| 清单字段与校验:`id`、`name`、`version`、`engines`、`dependencies`、`conflicts`、`capabilities`、`mounts` | 开发规范 2.1 字段与校验规则 |
| 能力分档、联网只经宿主网络能力、`net:fetch` 仅内置可见、`plugins:storage` 的存储边界与挂载点范围 | 开发规范 2.1、运行时规范 4、5.4 与 5.5 |
| 版本与兼容:三段版本、单段 `engines` 表达式、依赖与冲突按 id 判定;依赖在安装、启用、停用、卸载四处都生效 | 开发规范 3. 版本与依赖 |
| 加载方式的地址判定、清单优先级、跨源分发与 CORS | 运行时规范 2 与 3、开发规范 6.1 |
| 生命周期状态、能力限流与超时、上下文成员、可见数据范围 | 运行时规范 3、4、5 |
| 离线包的布局、`meta.json` 的字段规则与预检顺序 | 开发规范 4、6.2 |

挂载点是插件声明要挂到宿主哪个回调位置,清单里对应 `mounts` 字段:只声明位置名,处理器在激活时登记。

## 本文保留的 dsce 专有内容

以下内容模板仓库不覆盖,仍以本仓库的实现与文档为准:

| 主题 | 为什么留在本仓库 |
|:---:|:---:|
| 合集 CMS 签名、三层清单签名、来源结论与目录数据校验 | 与 [信任链与 PKI 签名](trust-chain.md) 配套,属于本仓库的 PKI 与插件市场实现 |
| 代码体积上限 2 MB,在线与离线包共用同一上限 | 上限取值由本仓库实现界定,模板 specs 已同步记载同一上限;调整该上限时两侧需要一起改 |
| 安装记录持久化(`<APP_NAME>-plugins` 的字段集合) | 本仓库 IndexedDB 的实现细节 |
| 引擎安装接口与离线包的两步安装 | 本仓库 `dsc-plugin-engine` 的宿主接口 |
| 错误与降级的原因代码与用户可见文案 | 与本仓库的 `i18n` 文案键配套 |
| 请求前补丁(`chat:request` 与挂载点 `chat:before-request`) | 模板规范尚未覆盖,补丁字段、范围裁剪与合并规则由本仓库引擎实现界定,写入路径在 `dsc-core` 的发送路径上 |
| 资产读取(`assets:read` 的三态结果与首次使用提示) | 模板规范尚未覆盖;三态口径、体积与超时上限、去重提示都由本仓库实现界定 |
| 插件声明供应端点(`provider:source` 与端点注册表) | 模板规范尚未覆盖;端点描述的字段、基址规范化、合并与冲突口径、凭证按端点与基址绑定且不出宿主的约束都由本仓库的引擎与内核实现界定 |
| 插件设置表面(`settings:surface`) | 模板规范尚未覆盖;字段描述的形态与校验、默认层与覆盖层的值语义、secret 走凭证库、宿主渲染与脏值生命周期都由本仓库的引擎实现界定 |
| 插件页面(`ui:page`) | 模板规范尚未覆盖;页面描述的形态与校验、四种区块、动作回调与页面数据挂载点都由本仓库的引擎实现界定 |

## 引擎安装接口

| 方式 | 接口 | 说明 |
|:---:|:---:|:---:|
| 直接注册 | `engine.install(manifest, plugin)` | 宿主已持有插件对象时使用,只登记不激活 |
| 运行时加载 | `engine.installFromUrl(url, manifest?)` | 引擎自身用 `fetch` 取产物字节(安装阶段行为,不占用插件能力),按文本存进安装记录后再以 Blob 地址 `import` 加载,成功后自动激活;超时 10 秒。自动启用命中冲突时安装仍成功,结果里的 `activation` 记录冲突描述,该插件保持停用且冲突双方一并被停用 |
| 手动激活 | `engine.activate(id)` | 依赖满足且与运行中的插件无冲突时进入 `active`;冲突时按保守策略处置:返回 `conflict` 及结构化冲突列表,同时停用本次冲突涉及的全部已启用插件并写入待决定记录;依赖未满足时不启用,记录标记为 `inactive` 并提示缺哪个 id |
| 处理待决定冲突 | `engine.pendingConflicts()`、`engine.resolvePendingConflict(groupId, keepId)` | 读取待决定记录(已按卸载清理);选择后删除该组记录并启用保留的那一个,其余保持停用,不连带启用依赖方 |
| 手动停用 | `engine.deactivate(id, options?)` | 存在已启用的插件依赖它时拒绝,返回 `depended-on` 与依赖方 id;成功时进入 `inactive`。`options.force` 表示用户明确要求强行停用,结论同样是拒绝,引擎不连带停用依赖方 |

地址规则、清单优先级与跨源取件要求见模板仓库的运行时规范 2、3 与开发规范 6.1;取件失败的表现见本文末的错误与降级表。

## 产物签名

插件产物有两套可选的分离签名,约定见 [信任链与 PKI 签名](trust-chain.md):

| 签名 | 签发方 | 随产物分发的文件 | 验签材料 |
|:---:|:---:|:---:|:---:|
| 合集 CMS 分离签名 | 合集 EEC 证书 | `plugin.js.sig` | 清单已登记时优先用清单证书,未登记时取来源站点的 `certs/<合集 id>/<合集 id>-eec.crt`,取不到再试旧站点的扁平路径 `certs/<合集 id>-eec.crt` 与最旧的 `eec.pem`;两种来源的证书都要先过本地证书链校验 |
| 三层清单签名 | 合集 EEC 证书 | 每层的 `manifest.json.sig` | 覆盖该层目录数据的哈希,不覆盖 `plugin.js`;验签口径与产物签名一致 |
| 整站签名 | 来源的整站签名证书 | `web_files.json.sig` 与逐文件 `<文件>.sig`(含 `plugin.js.sig`) | 证书按三档取件,先用内置根证书校链,再用它验清单与文件 |
| 作者裸签名 | 插件作者 | `plugin.js.author.sig` | 合集内的 `plugins/<作者>/author_pub.pem` |

合集签名为逐字节语义,签名对象是 `plugin.js` 的原始字节,签名者是该来源的 EEC 证书;作者签名为 Ed25519 裸签名,同样直接对原始字节签名。安装与启动时两种材料都有则须同时通过,只有一种则只校验该种,都没有按未校验处理。作者签名一律是可选的:作者不提供签名材料、只提供其中一项、或验签不通过,都不阻断安装与启动。校验失败只提示,不阻断安装与启动。`meta.json` 的完整性由合集的三层哈希清单覆盖,作者不为它签名。

合集的可信性由根 CA 签发的 EEC 证书证明,信任锚是构建时内嵌的根证书:证书字节可以来自 `trusted-manifest` 清单登记的 `eec` 路径,也可以来自来源站点的 `certs/<合集 id>/<合集 id>-eec.crt`(旧站点的扁平路径 `certs/<合集 id>-eec.crt` 与最旧的 `eec.pem` 仅作兼容兜底),但都必须先在本地通过证书链校验;链不通过时结论为 `failed` 且不再发起 CMS 验签。清单里没有该来源只影响界面标注,不影响能否验签。

安装记录与启动恢复按同一口径给出结论:

| 结论 | 含义 | 触发条件 |
|:---:|:---:|:---:|
| `confirmed` | 来源已确认 | 证书链在本地校验通过,且 CMS 验签通过 |
| `failed` | 校验未通过 | 证书链不通过(过期、非本根签发、被吊销),或拿不到证书、验签不通过 |
| `unknown` | 无法确认来源 | 完全没有来源信息 |
| `local` | 本地安装 | 用户上传的离线包,没有来源,不参与来源判定 |

链校验失败与证书吊销是确定的负面结论,按 `failed` 处理并区分原因文案;信任清单登记了证书而证书文件缺失时,界面单列「来源证书缺失」,不落到通用的「来源校验未通过」。安装记录用 `eec_anchored` 标记证书链是否已在本地校验通过,用 `source_trust`、`trust_failure` 保存信任清单判定。旧记录按未校验处理,启动恢复时重新做链校验并重写标记;没有任何一项校验字段的旧记录(升级前安装)在已安装列表额外提示重新安装,并按记录的同一版本提供重装入口,重装后字段齐备。

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

整站模型的验签顺序:取证书、用内置根证书在本地校链、用证书验 `web_files.json.sig`、按清单逐文件验签、安装与启动时按 `plugin.js.sig` 验整站签名、作者签名按材料单独校验。结论仍是三态:清单或签名缺失、证书缺失按未校验;链不通过、清单签名不通过、文件签名不通过按失败,失败只把目录数据结论降级为未校验,不阻断安装。

整站模型没有 L2 清单,安装来源里的 `authorPubSha512` 缺省,作者公钥不做哈希把关;整站模型也没有清单 `revision`,`manifest_revisions` 为空。整站签名不代替作者签名:作者签名由作者用自己持有的私钥签,合集只做收录与整站签名(或合集签名)。

## 插件声明供应端点

插件可以声明自己能为宿主提供哪些供应端点（provider endpoint，下称端点），但只交描述、不交执行代码。执行仍在 `dsc-core`：它按能力维度组装请求、解析回流，凭证由引擎在执行时取用。「端点」与插件安装来源（`inner`、`outer` 等）不是同一个概念，文档与界面不用「来源」指代它。

三个后果先交代清楚：

| 后果 | 说明 |
|:---:|:---:|
| 插件不参与请求组装 | 请求形态、请求头与回流形状都由内核按端点的协议格式决定，插件改不了 |
| 插件拿不到凭证 | 凭证按「端点 id + 规范化后的基址」存在引擎的 IndexedDB 里，插件既拿不到读写入口，也拿不到任何凭证值；内核只在执行时取用 |
| 插件不承担执行判定 | 能力是否可用由内核判定，失败按内核的错误类型回传 |

基址的协议与主机范围由宿主的策略决定，不是插件可申请的权限：默认只接受 https 与回环地址的 http；用户在设置里打开「允许局域网 http 供应端点」后，私有网段与其它非回环主机的 http 也会被接受。开关只作用于供应端点，插件的安装来源、市场来源与资产读取仍按原口径拒绝局域网 http。页面为 https 时浏览器会直接阻断对局域网 http 的混合内容请求，因此这条通道只适合本地开发或 http 页面。

声明的步骤：

1. 在清单的 `capabilities` 里申请 `provider:source`。
2. 在激活时调用 `context.provider.registerSource(descriptor)`，一个端点一次调用。
3. 描述按下面这张表填写。

| 字段 | 必填 | 说明 |
|:---:|:---:|:---:|
| `id` | 是 | 小写字母开头，允许数字、点、下划线与连字符，3 到 64 字符 |
| `label` | 是 | 展示名称，最多 40 字符；只用于展示，不参与冲突判定 |
| `format` | 是 | `anthropic-messages` 或 `openai-chat`；只描述线上协议，不指厂商 |
| `baseUrl` | 是 | 端点基址；登记前规范化，见下表 |
| `capabilities` | 是 | 该端点能提供的能力，不得为空、不得重复 |
| `endpoints` | 否 | 按能力覆盖端点路径，只允许站内绝对路径 |

基址在登记前统一规范化，规范化后的值同时用于比对与执行：

| 处理 | 规则 |
|:---:|:---:|
| 去空白 | 首尾空白一律去掉；不去掉时校验能过、执行期却会拼出非法地址 |
| 主机 | 转小写 |
| 端口 | 去掉默认端口（443、80） |
| 路径 | 去掉尾斜杠 |
| 拒绝 | 带 query、hash 或内嵌用户名密码的地址拒绝；非 https 且非回环地址的 http 默认拒绝，宿主打开「允许局域网 http 供应端点」开关后改按放行处理 |

登记的语义：

| 情形 | 结果 |
|:---:|:---:|
| 未申请 `provider:source` 就登记 | 抛 `PluginCapabilityError`，并提示 `pluginCapabilityDenied` |
| 描述不合格 | 抛 `PluginSourceError`，原因取 `id`、`label`、`format`、`baseUrl`、`capabilities`、`endpoints` 之一，并提示 `pluginSourceRejected` |
| 端点 id 与别的插件相同、定义也相同 | 合并成一个端点，能力清单取并集 |
| 端点 id 与别的插件相同、定义不同 | 先声明的那份临时生效，后声明的不生效，冲突记入引擎日志与 `engine.sourceRegistry()`；冲突方也记入声明方列表 |
| 同一插件在一次激活内声明超过 50 个端点 | 抛 `PluginRateLimitError`，该次激活失败并按失败路径撤销全部声明 |
| 插件停用或卸载 | 该插件的全部声明撤销，其他声明方仍可提供同一端点 |

定义比对只看 `format`、规范化后的 `baseUrl` 与 `endpoints` 三项；`label` 差异只算展示差异，不判冲突。未决期先声明的那份临时生效，代价必须知道：后声明方的插件会看到 id 在表里，但执行期只认先声明方的基址；冲突方声明的能力在冲突解决前不进能力矩阵；冲突是需要界面主动展示的状态，不展示等于没有标记；先声明方退出后，下一份声明重新成为唯一定义。

端点能力标识共九个：`text.generate`、`reasoning.think`、`vision.image`、`document.read`、`audio.asr`、`audio.tts`、`tool.web-search`、`tool.read-url`、`models.list`。当前只有 `text.generate` 与 `models.list` 已经落地，其余七项声明了也不会被执行：内核按 `unsupported` 拒绝，引擎侧对应 `capability-unimplemented`。描述里没有声明的能力同样拒绝，原因是 `capability`；基址不可用按 `endpoint` 拒绝。

示例（只声明，不执行）：

```js
export const manifest = {
  id: 'dsc-demo-source',
  name: 'Demo Source',
  version: '1.0.0',
  engines: '^1.0.0',
  capabilities: ['provider:source'],
}

export const activate = (context) => {
  context.provider.registerSource({
    id: 'demo-deepseek',
    label: 'Demo DeepSeek',
    format: 'anthropic-messages',
    baseUrl: 'https://api.deepseek.com',
    capabilities: ['text.generate', 'models.list'],
  })
}
```

声明不发起任何网络请求，也不代表宿主立刻会使用这条来源：界面上是否启用、凭证怎么填，由宿主决定。要在自己声明的端点上执行一次调用，需要另外申请 `provider:run`；调用形态、返回形态与错误码见 [从零编写一个 dsc 插件](../framework/build-a-plugin.md) 的「调用供应端点」一节。

## 插件设置表面

插件可以在清单里申请能力 `settings:surface`,在激活期用 `context.settings.register(descriptor)` 登记一份字段描述,宿主据此渲染设置表单。与供应端点声明同法,插件只交描述、不交控件:控件形态、样式与 i18n 全部归宿主,这是能力白名单模型下与 dsh(插件自带 React 组件)的关键差异。

字段类型枚举五种:`switch`、`select`、`number`、`text`、`secret`;每个字段给 `key`(`^[a-z][a-z0-9-]{0,63}$`,描述内不得重复)、`labelKey` 或 `label`(二选一,前者必须是宿主 i18n 字典里的键)、`default` 与取值范围或选项。校验即拒绝:重复 key、未知类型、非法 default、非法 labelKey、编译不过的 pattern、超规模(最多 32 个字段、序列化后不超过 8 KB)都让整份注册失败,抛 `PluginSettingsError`,`code` 是结构化的问题码,同时提示 `pluginSettingsRejected`。登记返回释放函数,停用随引擎清理;页面 id 就是插件 id,不允许自定义,同一插件再次登记时替换前一份。

值分两层:默认层来自描述的 `default`,用户覆盖层落在 dsc-core 的设置命名空间(`<APP_NAME>:plugin-settings:<pluginId>`,概念上是 `settings/<pluginId>/<fieldKey>`),与 `plugins:storage` 的插件数据完全分开——插件用 `storage.set` 写不到这张表,写侧只有引擎门面 `engine.pluginSettings(pluginId)` 的 `set` / `reset` / `resetAll`,写入前按描述校验,无法绕过。插件侧只有 `context.settings.values()` 一个只读入口,读自身命名空间,其他插件的设置不可见。

`secret` 字段不设默认值、不落设置存储:值复用供应端点凭证库(同一张表、同一套内存镜像与降级口径,键的 source_id 带 `plugin-secret:` 前缀,与端点 id 词表不相交),只写不读,读侧只回答「是否已配置」。卸载时登记随停用撤销,覆盖值与秘密值由引擎一并清除,不在遗留数据区出现。

宿主 UI:已安装列表点插件名进详情页(不做路由,返回即回列表),详情页由宿主按描述渲染表单,五种字段各一个控件。脏值生命周期照抄 dsh:改动即脏、保存才落盘、字段级非法阻塞保存、保存失败保留草稿、离开页面丢弃草稿;每个字段带「已修改」徽标与「重置为默认」按钮。没有登记描述的插件显示「本插件没有可配置项」。

## 插件页面

插件可以在清单里申请能力 `ui:page`,在激活期用 `context.ui.registerPage(descriptor)` 登记一份声明式页面描述,宿主据此在插件面板的「插件页面」标签页渲染页面。与设置表面同法,插件只交描述、不交控件:控件形态、样式与 i18n 全部归宿主,这是插件没有 React 能力时的页面形态。

页面描述顶层是 `{ id, titleKey 或 title, blocks }`:页面 id 与插件 id 共同构成页面入口的键,标题是页面入口的名字,区块数组 1 到 64 个、按声明顺序渲染。区块四种:`text`(静态说明,1 到 2000 字符)、`list`(条目数组至多 200 条,每条带标题、可选说明与徽标,可带一个逐条动作)、`form`(复用设置表面的五种字段描述与控件)、`actions`(按钮组至多 8 个)。校验即拒绝:非法 id、非法标题、空区块、重复区块 id、未知区块类型、非法条目、非法动作、非法说明文字、非法表单字段、跨区块重复字段键或超规模(描述序列化后不超过 8 KB)都让整份注册失败,抛 `PluginPageError`,`code` 是结构化的问题码,同时提示 `pluginPageRejected`。登记返回带页面 id 的句柄,停用随引擎清理;同一插件重复登记同 id 页面时替换前一份。

页面有两个挂载点,登记时要求清单同时申请能力与对应挂载点:`ui:page-action` 在用户点击动作按钮时由引擎同步回调插件,载荷 `{ pageId, actionId, itemKey?, form? }`(`itemKey` 只有逐条动作带,`form` 是页面表单区块的当前草稿值);`ui:page-data` 在宿主进入页面或动作返回刷新指示时由引擎同步索取当前模型。动作处理器同步返回 `{ refresh: true }` 表示页面数据已变化,宿主随即重新索取模型;异步工作(如安装资产)由插件自行发起,完成后用 `notify` 提示。未实现 `ui:page-data` 的插件页面用登记时的描述静态显示;实现了的话,返回的模型按登记期同一份校验,非法、抛错或页面 id 不一致时回落到缺省模型。

宿主 UI:插件面板第三个标签页「插件页面」与「已安装」「插件市场」同级,每个已登记页面的插件各得一个入口,名字用页面标题;页面内容区复用设置详情页的控件与样式 token。不做路由、不做模态遮罩:返回即回页面列表,遵守界面交互禁令(只用气泡通知与悬浮卡片)。清理:停用撤销全部页面登记与两个挂载点处理器,卸载时引擎再兜底清一次。

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
| `eec_anchored` | 证书链是否已在本地校验通过;旧记录按未校验处理,启动恢复时重新校验并重写该标记 |
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
| 能力或挂载点未知 | 安装拒绝,原因 `unknown-capability` 或 `unknown-mount` |
| 版本不兼容 | 安装拒绝,原因 `incompatible-version` |
| 重名、缺依赖 | 安装拒绝,原因 `duplicate`、`missing-dependency` |
| 安装期冲突(两个方向) | 安装拒绝,原因按声明方向分成三条:本插件的 `conflicts` 命中已安装记录为 `install-conflict-declared`,已安装记录声明排斥本插件为 `install-conflict-required`,两边互相声明为 `install-conflict-mutual`;结果另带 `conflicts` 列出全部冲突对(含声明方与方向),`detail` 给出同类冲突里对方插件的 id;已安装记录不分启停都参与,拦的是共存 |
| 启用时依赖未安装或未启用 | 不启用:记录标记为 `inactive`,错误字段写入 `missing-dependency:<id>`,并提示缺哪个 id;不留下「已启用但启动失败」的记录 |
| 停用时仍有已启用的插件依赖它 | 停用拒绝,原因 `depended-on`,提示「以下插件正在使用它,请先停用对方」并列出这些插件;强行停用标志同样被拒绝,引擎不连带停用依赖方 |
| 依赖的插件被停用、卸载或启动失败 | 依赖它的已启用插件自动停用并逐个提示,原因写入 `missing-dependency:<id>`;列表里的「依赖未满足」徽标常驻显示原因 |
| 启用时与运行中的插件冲突 | 按保守策略处置:冲突涉及的已启用插件全部停用(含正在运行的一方),整组冲突写入待决定记录并落盘,同时发出一条警告说明冲突双方与声明方向;启用结果仍为 `conflict` 及结构化冲突列表 |
| 用户对待决定冲突做出选择 | 删除该组记录,按选择启用保留的那一个,其余保持停用;不连带启用依赖它的插件 |
| 启动时存在待决定记录 | 记录涉及的插件一律不自动启用,界面在已安装列表顶部显示待决定状态;记录里的插件已卸载时清理该条记录 |
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
| 超出限流 | 抛 `PluginRateLimitError`,并提示 `pluginCallRateLimited`;`events.on` 与 `chat.onBeforeRequest` 按登记次数计,事件回调与请求前调用不占用名额 |
| 调用超时或被取消 | 抛 `PluginTimeoutError` 或 `PluginAbortError` |
| 事件处理器抛错 | 只写入该插件日志,不影响其他处理器 |
| `net:fetch` 违反协议、方法或响应类型 | 抛 `PluginFetchError`,`reason` 为 `protocol`、`content-type` 等 |
| `net:fetch` 超时或响应体超过 512KB | 真正中止请求并抛 `PluginFetchError`,`reason` 为 `timeout` 或 `too-large` |
| `assets:read` 违反协议、超时或响应体超过 512KB | 拒绝或中止请求并抛 `PluginAssetError`,`reason` 为 `protocol`、`timeout`、`too-large` 等 |
| `assets:read` 拿到 HTTP 状态码或没有状态码 | 不抛错,按三态结果交给插件;`status` 与 `no-status` 的区别由插件自行处理 |
| 插件首次读取某个来源地址 | 提示用户一次 `pluginAssetSourceFirstUse`;之后的读取失败只写该插件的插件日志 |
| 插件数据超过 64KB 或无法序列化 | 抛 `PluginDataError`,并提示 `pluginDataQuotaExceeded` 或 `pluginDataInvalid` |
| 声明供应端点时描述不合格 | 抛 `PluginSourceError`,原因取 `id`、`label`、`format`、`baseUrl`、`capabilities`、`endpoints` 之一,并提示 `pluginSourceRejected` |
| 两个插件声明同一端点 id 但定义不同 | 先声明的那份临时生效,后声明不生效,冲突记入引擎日志与 `engine.sourceRegistry()` |
| 端点换过主机后旧凭证被读取 | 读取结论为 `stale`,不复用旧 Key,要求重新填写 |

所有用户可见提示复用宿主 `i18n` 文案,插件不自行拼接中文文案。
