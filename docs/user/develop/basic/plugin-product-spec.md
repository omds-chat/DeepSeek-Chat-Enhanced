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

`plugins:storage` 对第三方插件开放，但数据保存在浏览器本地，随站点数据清除而丢失，插件不得把它当作可靠存储。

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

`url` 只接受 http 与 https，按页面地址解析相对路径；其他协议直接拒绝，结果为 `load-failed`。

清单优先级：`installFromUrl(url, manifest)` 显式传入的清单优先；未传入时使用产物导出的 `manifest`；两者都没有时安装被拒绝，原因为 `invalid-manifest`，并提示 `pluginManifestMissing`。

## 安装持久化

引擎把安装记录写入 localStorage 的 `<APP_NAME>:plugins` 键，每条包含清单、来源与启用状态：

| 字段 | 说明 |
|:---:|:---:|
| `manifest` | 安装时的完整清单 |
| `source` | `builtin` 表示内置插件；`url` 附带运行时地址 |
| `enabled` | 用户期望的运行状态 |

页面启动时引擎先装载内置插件，再按记录恢复 `url` 来源的插件：加载成功则重新注册并按 `enabled` 决定是否激活；加载失败只把该插件标记为 `failed` 并在 `list()` 中可见，不阻塞启动与其他插件。宿主通过 `install()` 直接注册的插件没有可恢复来源，不写入该记录。

## 错误与降级

| 情形 | 行为 |
|:---:|:---:|
| 清单非法 | 安装拒绝，原因 `invalid-manifest` |
| 能力或贡献点未知 | 安装拒绝，原因 `unknown-capability` 或 `unknown-contribution` |
| 版本不兼容 | 安装拒绝，原因 `incompatible-version` |
| 重名、缺依赖、冲突 | 安装拒绝，原因 `duplicate`、`missing-dependency`、`conflict` |
| 产物无法加载或导出不符 | 安装拒绝，原因 `load-failed` 或 `invalid-plugin` |
| 产物未导出清单且未传入清单 | 安装拒绝，原因 `invalid-manifest`，并提示 `pluginManifestMissing` |
| 激活抛错或超时 | 插件标记 `failed`，引擎与其他插件继续运行 |
| 未授予的能力被调用 | 抛 `PluginCapabilityError`，并提示 `pluginCapabilityDenied` |
| 超出限流 | 抛 `PluginRateLimitError`，并提示 `pluginCallRateLimited` |
| 调用超时或被取消 | 抛 `PluginTimeoutError` 或 `PluginAbortError` |
| 事件处理器抛错 | 只写入该插件日志，不影响其他处理器 |
| `net:fetch` 违反协议、方法或响应类型 | 抛 `PluginFetchError`，`reason` 为 `protocol`、`content-type` 等 |
| `net:fetch` 超时或响应体超过 512KB | 真正中止请求并抛 `PluginFetchError`，`reason` 为 `timeout` 或 `too-large` |
| 插件数据超过 64KB 或无法序列化 | 抛 `PluginDataError`，并提示 `pluginDataQuotaExceeded` 或 `pluginDataInvalid` |

所有用户可见提示复用宿主 `i18n` 文案，插件不自行拼接中文文案。
