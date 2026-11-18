# dsc 插件产物规范

本文规定 dsc 插件的产物形态、导出契约、清单字段、版本与兼容、加载方式以及错误与降级行为。规范内容与 `dsc-plugin-engine` 的当前实现一致，未实现的能力不写入本文。

## 产物形态

| 项 | 规定 |
|:---:|:---:|
| 文件数量 | 单个 js 文件，可附带该文件自身引用的资源 |
| 模块格式 | 浏览器可 `import` 的 ESM；不使用 `require`、Node 内置模块与后端接口 |
| 运行环境 | 页面主线程，可用浏览器 API；不得读写本地文件系统 |
| 依赖 | 不得新增运行依赖；可复用宿主已加载的浏览器能力 |
| 样式 | 自行注入并清理，不覆盖宿主已有类名 |

## 导出契约

产物必须导出以下之一：

| 导出形态 | 说明 |
|:---:|:---:|
| `export const activate` | 具名导出插件对象，`activate(context)` 必填 |
| `export default` | 默认导出插件对象或插件工厂 |
| 插件工厂 | 函数，返回插件对象或返回它的 Promise |
| `export const manifest` | 具名导出清单；`installFromUrl` 未传入清单时使用 |

插件对象：

| 成员 | 必填 | 说明 |
|:---:|:---:|:---:|
| `activate(context)` | 是 | 启动入口，可返回 Promise；超时 5 秒 |
| `deactivate()` | 否 | 停用入口，可返回 Promise；超时 3 秒，之后执行注册的释放函数 |

产物可以同时导出具名 `manifest`，引擎在运行时加载时读取它，作为未传入清单时的安装依据；写在 `default` 导出对象上的 `manifest` 同样被识别，模块顶层的具名导出优先。

## 清单字段

| 字段 | 必填 | 规定 |
|:---:|:---:|:---:|
| `id` | 是 | 小写字母开头，允许数字与连字符，3 到 64 字符，全局唯一 |
| `name` | 是 | 展示名称，不得为空 |
| `version` | 是 | `主版本.次版本.修订号` |
| `engines` | 否 | 兼容的 dsc-core 版本范围 |
| `dependencies` | 否 | 依赖的插件 id；安装时须已存在，激活时须已激活 |
| `conflicts` | 否 | 冲突的插件 id；同时安装被拒绝 |
| `capabilities` | 是 | 申请的能力，不得重复 |
| `contributions` | 否 | 订阅的贡献点，不得重复 |

能力分三档：

| 能力 | 可见范围 | 说明 |
|:---:|:---:|:---:|
| `sessions:list`、`sessions:read`、`sessions:rename`、`events:session`、`notify`、`settings:locale` | 全部插件 | 会话只读视图、事件订阅、宿主提示与当前语言 |
| `plugins:storage` | 全部插件 | 插件自身的键值数据，保存在浏览器 localStorage |
| `net:fetch` | 仅内置插件 | 读取外源文本资源，例如插件索引 |

`net:fetch` 对第三方插件不可见：引擎维护一份内置插件 id 集合，只有集合内的插件申请该能力才会被接受；第三方清单里写 `net:fetch` 时安装结果为 `unknown-capability`，与申请一个不存在的能力表现完全一致。

`plugins:storage` 对第三方插件开放，但数据保存在浏览器本地，随站点数据清除而丢失，插件不得把它当作可靠存储。卸载插件时引擎清除该插件的全部插件数据，重新安装后读不到旧数据。

贡献点仅限 `session:changed`。

## 版本与兼容

- `version` 为插件自身版本，只允许三段数字。
- `engines` 与 dsc-core 版本比较，支持 `^`、`~`、`>=`、`<=` 与精确版本；`^` 要求主版本一致且不低于下界，`~` 要求主次版本一致且不低于下界。
- `engines` 缺省视为不限制；不满足时安装被拒绝，原因为 `incompatible-version`。
- 依赖与冲突按插件 id 判定，不比较版本。

## 加载方式

| 方式 | 接口 | 说明 |
|:---:|:---:|:---:|
| 直接注册 | `engine.install(manifest, plugin)` | 宿主已持有插件对象时使用，只登记不激活 |
| 运行时加载 | `engine.installFromUrl(url, manifest?)` | 按 `import` 加载产物，成功后自动激活；超时 10 秒 |
| 手动激活 | `engine.activate(id)` | 依赖满足时进入 `active` |

`url` 只接受 `https` 的任意主机，或 `http` 的本机回环地址（`localhost`、`127.0.0.1`、`[::1]`），按页面地址解析相对路径；其余地址直接拒绝，结果为 `load-failed`。

清单优先级：`installFromUrl(url, manifest)` 显式传入的清单优先；未传入时使用产物导出的 `manifest`；两者都没有时安装被拒绝，原因为 `invalid-manifest`，并提示 `pluginManifestMissing`。

### 跨源分发与 CORS

产物由浏览器按 ES 模块 `import` 加载,所以加载过程受模块脚本的跨源规则约束:

| 部署形态 | 托管方要求 | 结果 |
|:---:|:---:|:---:|
| 与页面同源 | 无需额外响应头 | 正常加载 |
| 与页面跨源 | 响应必须带 `Access-Control-Allow-Origin`,值为 `*` 或页面来源 | 缺该头时加载被拒绝 |

模块导入默认不携带凭证,所以 `Access-Control-Allow-Origin: *` 即可满足要求,不需要 `Access-Control-Allow-Credentials`。产物自行拆出的 chunk 与它引用的资源按同样的规则加载,跨源时也要带上该响应头,或者与入口放在同一个源下。

不满足时表现为安装失败:引擎把 `import` 抛出的错误写入 `engineLogs()`,安装结果为 `load-failed`,界面提示插件产物加载失败。`import()` 被拒绝时给出的错误文本不含 CORS 细节,具体原因只在浏览器控制台可见。

## 产物签名

插件产物有两套可选的分离签名,约定见 [信任链与 PKI 签名](trust-chain.md):

| 签名 | 签发方 | 随产物分发的文件 | 验签材料 |
|:---:|:---:|:---:|:---:|
| 合集 CMS 分离签名 | 合集 EEC 证书 | `plugin.js.sig`、`meta.json.sig` | 该来源根目录的 `eec.pem`,或 online-data 信任清单里登记的证书 |
| 作者裸签名 | 插件作者 | `plugin.js.author.sig`、`meta.json.author.sig` | 合集内的 `plugins/<作者>/author_pub.pem` |

合集签名为逐字节语义,签名对象是 `plugin.js` 的原始字节,签名者是该来源的 EEC 证书;作者签名为 Ed25519 裸签名,同样直接对原始字节签名。安装与启动时两种材料都有则须同时通过,只有一种则只校验该种,都没有按未校验处理。校验失败只提示,不阻断安装与启动。

合集的可信性由根 CA 签发的 EEC 证书证明:网页从 online-data 分支的 `index.json` 找到该合集的 `eec` 路径,用 `root_ca.crt` 校验证书链;清单里没有该来源时标记为未校验,只警告不阻断。

## 本地离线包

本地插件由用户上传,面板一次只接受一个文件,扩展名为 `.zip` 或 `.tgz`。包内产物形态:

| 包格式 | 产物位置 | 说明 |
|:---:|:---:|:---:|
| zip | 包根目录 | 根目录直接放 `meta.json` 与 `plugin.js`,可选作者签名 `plugin.js.author.sig` 与 `author_pub.pem`;子目录内容忽略 |
| tgz(npm 包) | `package/dist/` | 只取该目录下的文件,`package/` 下的其他内容一律忽略 |

`meta.json` 遵循运行时 meta schema,引擎只做最小校验:`name`、`version`、`author` 非空,`version` 为三段数字。`meta.json` 里的 `capabilities` 用于推导安装清单(与插件市场同一 id 规则);缺该字段时使用产物导出的 `manifest`,两者都没有时安装被拒绝,原因为 `invalid-manifest`。

签名规则:包内同时提供 `plugin.js.author.sig` 与 `author_pub.pem` 时按约定校验作者对 `plugin.js` 的裸公钥分离签名,校验不通过只提示,不拒绝安装,记录标记为校验失败;包内没有签名材料时同样允许安装,记录标记为未校验,界面在确认对话框中提示该插件未经签名校验。合集签名 `plugin.js.sig` 与 `meta.json.sig` 属于合集分发产物,不在离线包内校验。签名约定见 [信任链与 PKI 签名](trust-chain.md) 。

单个插件的 `plugin.js` 上限 1 MB,超出即拒绝安装,原因为 `package-too-large`:本地插件的代码文本要存进 IndexedDB,异常大的包会挤占存储配额,而本地插件没有外部来源可回退。

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
| `source_url` | 在线插件的 `plugin.js` 地址;`local` 来源留空 |
| `eec` | 合集 EEC 证书 PEM,启动校验时用于 CMS 验签 |
| `sig` | `plugin.js.sig` 的 base64 |
| `author_pub` | 作者公钥 PEM,启动校验时用于作者裸签名验签 |
| `author_sig` | 作者签名的 base64 |
| `code` | 本地插件的插件代码文本；在线插件不写该字段 |
| `enabled` | 用户期望的运行状态 |

四个签名字段缺失表示该记录没有对应的签名材料,启动校验按未校验处理;离线包只写 `author_pub` 与 `author_sig`,不写 `eec` 与 `sig`。

页面启动时引擎先装载内置插件,再按记录恢复外部插件:在线插件按 `source_url` 重新加载,本地插件用存储的 `code` 重建模块;带签名材料时先对代码字节验签。加载或验签失败只把该插件标记为 `failed` 并在 `list()` 中可见,不阻塞启动与其他插件。宿主通过 `install()` 直接注册的插件没有可恢复来源,不写入该记录。

卸载插件时，引擎在移除记录后清除该插件的 `plugins:storage` 数据；清理失败只写入 `engineLogs()`，不影响卸载结果。

## 错误与降级

| 情形 | 行为 |
|:---:|:---:|
| 清单非法 | 安装拒绝，原因 `invalid-manifest` |
| 能力或贡献点未知 | 安装拒绝，原因 `unknown-capability` 或 `unknown-contribution` |
| 版本不兼容 | 安装拒绝，原因 `incompatible-version` |
| 重名、缺依赖、冲突 | 安装拒绝，原因 `duplicate`、`missing-dependency`、`conflict` |
| 产物无法加载或导出不符 | 安装拒绝，原因 `load-failed` 或 `invalid-plugin` |
| 产物未导出清单且未传入清单 | 安装拒绝，原因 `invalid-manifest`，并提示 `pluginManifestMissing` |
| 离线包扩展名不是 `.zip` 或 `.tgz` | 预检拒绝,原因 `unsupported-package` |
| 离线包无法解压,或 `plugin.js` 不是合法文本 | 预检拒绝,原因 `corrupt-package` |
| 离线包缺少 `meta.json` 或 `plugin.js` | 预检拒绝,原因 `missing-meta` 或 `missing-plugin` |
| 离线包 `meta.json` 不合规 | 预检拒绝,原因 `invalid-meta` |
| 离线包作者签名校验未通过 | 不拒绝安装,记录标记为 `failed` 并提示 |
| 离线包 `plugin.js` 超过 1 MB | 预检拒绝,原因 `package-too-large` |
| 激活抛错或超时 | 插件标记 `failed`，引擎与其他插件继续运行 |
| 未授予的能力被调用 | 抛 `PluginCapabilityError`，并提示 `pluginCapabilityDenied` |
| 超出限流 | 抛 `PluginRateLimitError`，并提示 `pluginCallRateLimited` |
| 调用超时或被取消 | 抛 `PluginTimeoutError` 或 `PluginAbortError` |
| 事件处理器抛错 | 只写入该插件日志，不影响其他处理器 |
| `net:fetch` 违反协议、方法或响应类型 | 抛 `PluginFetchError`，`reason` 为 `protocol`、`content-type` 等 |
| `net:fetch` 超时或响应体超过 512KB | 真正中止请求并抛 `PluginFetchError`，`reason` 为 `timeout` 或 `too-large` |
| 插件数据超过 64KB 或无法序列化 | 抛 `PluginDataError`，并提示 `pluginDataQuotaExceeded` 或 `pluginDataInvalid` |

所有用户可见提示复用宿主 `i18n` 文案，插件不自行拼接中文文案。
