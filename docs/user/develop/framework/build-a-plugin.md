# 从零编写一个 dsc 插件

本文从一个空文件开始,写出一份能被 dsc 识别、安装并运行的插件,并说明如何验证、打包与分发。

## 插件是什么

dsc 插件在运行阶段就是一个符合 [dsc 插件产物规范](../basic/plugin-product-spec.md) 的 `js` 文件:它以 ESM 形式被 `dsc-plugin-engine` 加载,导出一个插件对象,在激活时拿到引擎提供的 `context`。

插件与宿主之间只有一条通道:`context` 上的受限能力对象。插件拿不到 `dsc-core` 的内部接口、`zustand` store 句柄与 IndexedDB 句柄,也拿不到任何 DOM 或插槽接口。绕过 `context` 直接操作宿主不受支持,引擎会识别这类行为并提示用户。

插件的运行状态有四种:

| 状态 | 含义 |
|:---:|:---:|
| `registered` | 已登记,尚未启动 |
| `active` | 已激活,能力可用 |
| `inactive` | 已停用,能力与挂载点已撤销 |
| `failed` | 启动失败,原因记录在插件日志与列表的错误字段 |

挂载点是插件声明要挂到宿主哪个回调位置:清单用 `mounts` 列出位置名,激活时再按位置登记处理器。后文的「[逐段说明](#逐段说明)」给出两项挂载点的差别。

## 运行环境

| 项 | 说明 |
|:---:|:---:|
| 运行位置 | 浏览器页面主线程 |
| 可用 API | 浏览器 API,例如 `localStorage`、`setTimeout`;联网不在其中,须走宿主提供的网络能力 |
| 不可用 | Node 内置模块、后端接口、本地文件系统、自行联网 |
| 依赖 | 不得新增运行依赖 |
| 宿主版本 | dsc-core `1.0.0`,对应清单的 `engines` 字段,写成单段版本范围 |

产物按普通 ESM 在页面内 `import`,因此必须是浏览器能直接解析的模块代码,不能包含 `require` 或打包器专用的运行时占位。

### 联网

联网受宿主管控,插件只能经宿主提供的网络能力发起请求:内置插件用 `context.net.getText` 与 `context.net.postJson`,协议、方法、响应类型、体积与超时都由宿主落实。

第三方插件当前拿不到这项能力:清单里申请 `net:fetch` 会被拒绝,与申请一个不存在的能力表现一致。需要联网的第三方插件应向宿主说明用途,由宿主决定是否开放。

资产读取是另一条通道:第三方插件可以申请 `assets:read`,用 `context.assets.readText` 或 `readBytes` 按地址读取远端文本或字节。它不是通用联网:只允许 GET、只允许 https(本机回环可用 http)、不带凭证,并且有体积上限与超时。

供应端点执行是第三条通道:第三方插件申请 `provider:source` 与 `provider:run` 后,可以在自己声明的端点上发起一次调用。它不是通用联网:只能打到注册表里选中的端点,端点基址在声明时校验,凭证由用户填写、引擎在执行时读取,请求形态与回流解析都由内核决定,插件既不能改地址,也拿不到 Key。

这条口径是契约约束,不是技术隔离:插件产物与宿主同源运行在同一个页面里,引擎无法在技术上阻止同源代码直接调用浏览器全局的 `fetch`。直接调用属于不合规,不能作为插件可以自行联网的依据。

## 最小可运行示例

### 源码

下面的代码申请两项能力:`events:session` 用于订阅会话切换事件,`plugins:storage` 用于保存自己的计数。

```ts
import type { PluginContext, PluginManifest } from './components/dsc-plugin-engine/index.js'

// 插件清单,从地址安装时以它为准
export const manifest: PluginManifest = {
  id: 'dsc-demo-log',
  name: 'Demo Log',
  version: '1.0.0',
  engines: '^1.0.0',
  capabilities: ['events:session', 'plugins:storage'],
  mounts: ['session:changed'],
}

// 启动入口,引擎在激活时调用,超时 5 秒
export const activate = (context: PluginContext) => {
  const stored = context.storage.get('switch-count')
  let count = typeof stored === 'number' ? stored : 0
  context.events.on('session:changed', (event) => {
    count += 1
    context.storage.set('switch-count', count)
    context.log('session:changed -> ' + String(event.activeId ?? 'none') + ' (' + count + ')')
  })
}

// 停用入口,可选;引擎在停用后仍会执行 events.on 返回的释放函数
export const deactivate = () => {}
```

`import type` 只是为了让编辑器拿到类型提示,编译后不会留在产物里。该路径指向本仓库的类型定义;独立插件项目可以复制这份类型声明,或使用 omds-chat 提供的 dsc 插件模板。

### 产物

插件最终交付的是去掉类型标注的 ESM 文件,内容与上面的源码等价:

```js
export const manifest = {
  id: 'dsc-demo-log',
  name: 'Demo Log',
  version: '1.0.0',
  engines: '^1.0.0',
  capabilities: ['events:session', 'plugins:storage'],
  mounts: ['session:changed'],
}

export const activate = (context) => {
  const stored = context.storage.get('switch-count')
  let count = typeof stored === 'number' ? stored : 0
  context.events.on('session:changed', (event) => {
    count += 1
    context.storage.set('switch-count', count)
    context.log('session:changed -> ' + String(event.activeId ?? 'none') + ' (' + count + ')')
  })
}
```

### 逐段说明

| 部分 | 作用 |
|:---:|:---:|
| `export const manifest` | 安装依据。用户从地址安装时不必再提供清单;写在 `default` 导出对象上也能识别,模块顶层的具名导出优先 |
| `capabilities` | 申请的能力,必须在核心能力表内且不得重复。未申请的能力被调用时抛 `PluginCapabilityError` |
| `mounts` | 声明要挂载的位置。只有声明了 `session:changed` 才能调用 `context.events.on('session:changed', ...)`;只有声明了 `chat:before-request` 才能调用 `context.chat.onBeforeRequest(...)` |
| `activate(context)` | 启动入口,可返回 Promise;抛错或超过 5 秒会让插件进入 `failed`,引擎与其他插件继续运行 |
| `deactivate()` | 停用入口,可选,可返回 Promise,超时 3 秒;之后引擎执行 `events.on` 返回的释放函数并清空挂载点 |

插件 id 的仓库约定是以 `dsc-` 开头。引擎的格式校验为小写字母开头、允许数字与连字符、长度 3 到 64。

### 能力清单

| 能力 | 可见范围 | `context` 成员 | 限流 |
|:---:|:---:|:---:|:---:|
| 无 | 全部插件 | `context.id` | — |
| 无 | 全部插件 | `context.version` | — |
| `sessions:list` | 全部插件 | `context.sessions.list` | 30 次 / 10 秒 |
| `sessions:read` | 全部插件 | `context.sessions.read` | 30 次 / 10 秒 |
| `sessions:rename` | 全部插件 | `context.sessions.rename` | 5 次 / 10 秒 |
| `events:session` | 全部插件 | `context.events.on` | 5 次 / 10 秒(仅登记) |
| `notify` | 全部插件 | `context.ui.notify` | 10 次 / 10 秒 |
| `settings:locale` | 全部插件 | `context.settings.locale` | 60 次 / 10 秒 |
| `plugins:storage` | 全部插件 | `context.storage.get`、`set`、`remove` | 100 次 / 10 秒 |
| `chat:request` | 全部插件 | `context.chat.onBeforeRequest` | 10 次 / 10 秒(仅登记) |
| `assets:read` | 全部插件 | `context.assets.readText`、`context.assets.readBytes` | 20 次 / 10 秒 |
| `provider:source` | 全部插件 | `context.provider.registerSource` | 50 次 / 10 秒(仅登记) |
| `provider:run` | 全部插件 | `context.provider.run` | 10 次 / 10 秒 |
| `net:fetch` | 仅内置插件 | `context.net.getText`、`context.net.postJson` | 10 次 / 10 秒 |

`context.id` 与 `context.version` 是引擎注入的两个只读成员,分别取自清单的 `id` 与 `version`,不需要申请能力,也不占用限流名额。

上表的限流只约束调用次数。单次超时只对异步成员生效: `context.sessions.list`、`context.sessions.read`、`context.settings.locale` 各 3 秒,外源请求由内核自己的超时中止(读取 10 秒、计数请求 5 秒),资产读取同样由内核在 10 秒后中止,`context.provider.run` 的 15 秒只覆盖「建立调用」这一段(`text.generate` 的回流在调用返回后惰性产出,不占这个预算);`context.sessions.rename`、`context.ui.notify` 与 `context.storage.get`、`set`、`remove` 是同步调用,没有超时。

`events:session` 与 `chat:request` 的限流只算登记次数:每次 `context.events.on`、每次 `context.chat.onBeforeRequest` 各占一个名额,之后的事件回调与请求前调用由引擎发起,不再占用名额。同一插件在一次激活内最多登记 5 个事件处理器,第 6 次登记在 10 秒窗口内抛 `PluginRateLimitError` 并提示 `pluginCallRateLimited`,窗口滚过之后可以继续登记。请求前处理器另有 10 毫秒的单次预算,见下文「[请求前补丁](#请求前补丁)」。

`net:fetch` 只对内置插件开放。第三方插件在清单里申请它时,安装结果为 `unknown-capability`,与申请一个不存在的能力表现一致;调用层还会再校验一次。第三方插件需要联网时由宿主决定是否开放,口径见上文「[联网](#联网)」。

`context.net.postJson` 只发一次 JSON 请求体,不等待响应内容:只允许 https,请求体与响应体上限各 4KB,超时 5 秒,不跟随重定向,响应体被丢弃。它面向不计结果的计数类请求,插件清单仍然只声明 `net:fetch`。

### 资产读取

申请 `assets:read` 后,插件可以按地址读取远端资产包的文本或字节,适合读取托管在 https 地址上的 JSON、图片等资产:

```js
export const manifest = {
  id: 'dsc-demo-asset',
  name: 'Demo Asset',
  version: '1.0.0',
  engines: '^1.0.0',
  capabilities: ['assets:read'],
}

export const activate = async (context) => {
  const result = await context.assets.readText('https://example.com/assets/persona.json')
  if (result.kind === 'content') {
    context.log('内容长度: ' + result.text.length)
  } else if (result.kind === 'status') {
    context.log('对方返回状态码: ' + result.status)
  } else {
    context.log('没有拿到状态码,地址或跨域配置需要确认')
  }
}
```

约束:只允许 GET;协议只允许 https,本机回环主机(`localhost`、`127.0.0.1`、`[::1]`)允许 http;不携带 Cookie,不发送自定义请求头,地址内嵌用户名或密码会被拒绝;响应体上限 512KB;超时 10 秒。

结果按观察到的事实分三态原样返回,引擎不猜测原因:

| `kind` | 含义 | 能据此判断什么 |
|:---:|:---:|:---:|
| `content` | 取到内容 | 正常消费 `text` 或 `bytes` |
| `status` | 拿到明确的 HTTP 状态码,没有内容 | 对方已放行跨域,状态码是对方给出的结论 |
| `no-status` | 只有网络层失败,没有任何状态码 | 地址无效或对方未开启跨域,两种可能无法区分 |

引擎侧能够确定的拒绝(地址不是绝对地址、协议不符、地址内嵌凭证、体积超限、超时、取消)抛 `PluginAssetError`,`reason` 取值为 `url`、`protocol`、`credential`、`too-large`、`timeout`、`aborted`。

该插件首次访问某个来源地址时,宿主会提示用户一次(同一插件与同一来源只提示一次),提示只说明哪个插件在访问哪个站点,不替用户判断站点是否可信;之后的失败只写入该插件的插件日志。

### 供应端点声明

申请 `provider:source` 后,插件可以声明自己能为宿主提供哪些供应端点(provider endpoint)。声明只交描述,不交执行代码:执行仍在内核,凭证由引擎在执行时取用,插件拿不到。字段、基址规范化与合并冲突口径见 [dsc 插件产物规范](../basic/plugin-product-spec.md) 的「插件声明供应端点」一节。

### 调用供应端点

声明只是把端点交给宿主;要让宿主在自己的端点上执行一次调用,清单还要申请 `provider:run`,然后在激活后用 `context.provider.run(capability, payload)` 发起。两条能力分开的原因:声明是交描述,执行会花用户填的 Key 与端点额度,授权单位不该相同。

端点的选择权在宿主,本版取注册表里该能力的第一个端点,插件不能指定端点,也不能读取凭证:引擎按选中的端点读出 Key,连同描述与载荷交给内核,插件只拿到回流事件或结果。

```js
export const manifest = {
  id: 'dsc-demo-source',
  name: 'Demo Source',
  version: '1.0.0',
  engines: '^1.0.0',
  capabilities: ['provider:source', 'provider:run'],
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

export const ask = async (context) => {
  const result = await context.provider.run('text.generate', {
    model: 'deepseek-flash',
    system: '你是助手',
    messages: [{ role: 'user', content: '你好' }],
  })
  if (result.kind !== 'stream') {
    return
  }
  for await (const event of result.events) {
    if (event.type === 'text') {
      context.log(event.text)
    }
  }
}

export const models = async (context) => {
  const result = await context.provider.run('models.list', {})
  if (result.kind === 'models') {
    context.log(result.models.map((model) => model.id).join(','))
  }
}
```

返回形态按能力区分:`text.generate` 给 `{ kind: 'stream', events }`,逐条产出 `text`、`thinking`、`title` 与 `end` 四类事件,鉴权与网络失败要到第一次迭代时才抛出;`models.list` 给 `{ kind: 'models', models }`,每项只有 `id`。本版只接通这两项,其余七项能力在执行前抛 `PluginProviderRunError`,码为 `capability-unimplemented`,重试没有意义。

失败一律抛 `PluginProviderRunError`,按 `error.code` 区分原因,原文在 `error.detail`,错误对象另带 `capability` 与 `sourceId`:

| `code` | 含义 |
|:---:|:---:|
| `credential-missing` | 还没有该「端点 id + 基址」的凭证,或凭证存储读不出来 |
| `credential-stale` | 端点换过主机,旧凭证不能复用 |
| `credential-rejected` | 端点以 401 或 403 拒绝凭证 |
| `capability-unavailable` | 没有端点提供该能力,或选中的端点未声明它 |
| `capability-unimplemented` | 端点声明了该能力,本版尚未接通 |
| `endpoint-unreachable` | 请求没有拿到响应:网络层失败或基址不可用 |
| `protocol-error` | 拿到响应但不符合协议 |

引擎不为这类失败弹宿主提示,由插件决定提示还是降级;需要提示用户时用 `context.ui.notify` 与既有文案键。

各能力的完整签名与可见数据范围见 [dsc 插件开发规范](../basic/plugin-develop-spec.md)。

### 请求前补丁

申请 `chat:request` 并在清单里声明挂载点 `chat:before-request` 后,插件可以为每次请求提供参数补丁:

```js
export const manifest = {
  id: 'dsc-demo-patch',
  name: 'Demo Patch',
  version: '1.0.0',
  engines: '^1.0.0',
  capabilities: ['chat:request'],
  mounts: ['chat:before-request'],
}

export const activate = (context) => {
  context.chat.onBeforeRequest((preview) => {
    // 只在用户要求简短时才收紧输出上限
    if (!preview.lastUserMessage.includes('简短')) {
      return null
    }
    return { maxTokens: 256, systemPromptAppend: '请尽量简短。' }
  })
}
```

处理器拿到的切片只有一项 `lastUserMessage`,即本轮请求里最后一条用户消息的文本;不给整段会话,也不给模型、思考与工具开关。返回 `null` 或什么都不返回表示不改请求。

补丁字段与范围:越界按边界裁剪,未知字段静默丢弃,空白字符串按未提供处理。

| 字段 | 形态 | 范围 | 效果 |
|:---:|:---:|:---:|:---:|
| `temperature` | 数字 | 0 到 2 | 采样温度 |
| `topP` | 数字 | 0 到 1 | 核采样 |
| `maxTokens` | 正整数 | 1 到 4096 | 单轮输出上限 |
| `stop` | 字符串数组 | 最多 4 条,每条最多 32 字符 | 停止词 |
| `systemPromptAppend` | 字符串 | 最多 2000 字符 | 追加到系统提示词之后 |
| `systemPromptReplace` | 字符串 | 最多 8000 字符 | 整体替换系统提示词 |

多个插件同时登记时按登记顺序合并:标量以后登记者为准,`stop` 取并集,`systemPromptAppend` 按顺序拼接。

调用约束:

| 情形 | 行为 |
|:---:|:---:|
| 未申请 `chat:request` 或未声明 `chat:before-request` | 抛 `PluginCapabilityError`,并提示 `pluginCapabilityDenied` |
| 全部处理器共用 10 毫秒预算 | 超预算时整份补丁作废,请求按原参数发出 |
| 处理器抛错 | 整份补丁作废,请求按原参数发出 |
| 补丁被裁剪 | 按边界裁剪后生效,首次提示一次 `pluginRequestPatchClamped` |

补丁不阻断请求:超时或抛错时请求照常发出,原因只写引擎日志(抛错同时写该插件的插件日志),插件列表里不会因此变成 `failed`。同步计算无法中断,10 毫秒是引擎在处理器返回后能判定的边界,不是强制终止。

## 本地加载验证

1. 准备产物:一个 js 文件,例如 `dsc-demo-log.js`。
2. 用本机静态服务器以 `http://localhost` 提供该文件,例如 `http://localhost:8090/dsc-demo-log.js`。地址规则:允许 `https://` 的任意主机,或 `http://localhost`、`http://127.0.0.1`、`http://[::1]`;其余协议与主机一律拒绝。
3. 打开插件面板,在「从地址安装」中粘贴产物地址,点击「安装」。
4. 安装成功后插件自动激活,「已安装」中出现该插件,状态为「运行中」。
5. 点击「查看日志」可看到 `context.log` 写入的内容;切换会话后再次查看,计数递增。

两点补充:

- 面板与 `installFromUrl(url, manifest?)` 共用同一地址判定,所以本地 `http://localhost` 地址可以直接从面板安装;分发给用户时仍应使用 `https` 地址。
- 产物改动后需要先在面板卸载再重新安装;取件带 `cache: 'no-store'`,若托管方对产物另设了长时间缓存,必要时更换文件名或地址。

## 发布成单个 js 产物

| 要求 | 说明 |
|:---:|:---:|
| 入口 | 一个 js 文件,浏览器可直接 `import` 的 ESM |
| 导出 | 保留 `export const manifest` 与 `export const activate` |
| 依赖 | 第三方依赖内联进产物,不新增运行依赖 |
| 资源 | 样式、字体、图片内联进产物;相对路径导入在安装后不会生效,运行时取资源属于联网,须走宿主网络能力(见「[联网](#联网)」) |
| 格式 | 不使用 `require`、Node 内置模块与打包器专用运行时 |

打包时注意:

- 把入口配置为 ESM 库,保留 `manifest` 与 `activate` 两个导出,不要产出仅供应用使用的 HTML 入口。
- 产物必须单文件:安装后代码按文本存进浏览器本地,加载时用的是 Blob 地址,拆分出来的 chunk 与相对路径资源无法解析。
- 构建完成后在浏览器控制台直接 `import('https://example.com/dsc-demo-log.js')` 一次,确认没有语法错误与缺失依赖。

## 打包成离线包

用户也可以拿到一个文件直接本地安装,不必自己搭静态服务器。引擎接受两种离线包:

| 格式 | 目录布局 | 生成方式 |
|:---:|:---:|:---:|
| zip | 根目录直接放 `meta.json` 与 `plugin.js`,可选作者签名 `plugin.js.author.sig` 与 `author_pub.pem` | 进入 `dist/` 后打包:`zip -r ../dsc-demo-log-1.0.0.zip .` |
| npm 包(`.tgz`) | 产物在 `package/dist/` 下 | 在插件项目根目录执行 `pnpm pack` |

zip 的要点:

- 压缩包根目录就是 `dist/` 的内容,不能再套一层目录;根目录下多一层 `dist/` 会导致安装时提示缺少 `meta.json`。
- 只识别 `meta.json`、`plugin.js` 与作者签名材料 `plugin.js.author.sig`、`author_pub.pem`,其余文件会被忽略,不影响安装。
- 用命令行打包,避免系统压缩工具写入额外的元数据目录。
- Windows 上不要直接用 `Compress-Archive` 压缩 `dist` 目录,它会把目录名套进包内;进入 `dist` 后执行 `tar -a -c -f ..\plugin.zip *`,或用资源管理器选中目录内的文件再压缩。

npm 包的要点:

- 用 `pnpm pack` 或 `npm pack` 生成,包内路径固定为 `package/dist/...`。
- `package.json` 的 `files` 需要包含 `dist`,否则产物不会进包。
- `package/` 下的其他内容被忽略,只安装 `package/dist/` 下的文件。

`meta.json` 是安装依据:预检先确认包内有 `meta.json` 与 `plugin.js`,再确认 `plugin.js` 不超过 2 MB,然后把 `meta.json` 按 UTF-8 解码并解析。`meta.json` 不是合法 UTF-8 时按 `invalid-meta` 拒绝;解码成功后要求 `name`、`version`、`author` 非空且版本号为三段数字。清单里的 `capabilities` 用来推导安装清单,缺该字段时改用产物导出的 `manifest`,两者都没有时安装失败。`mounts` 不影响能否推导清单:`meta.json` 写了就原样带进清单,没写时由引擎用产物导出的 `manifest.mounts` 补齐,因此同一份产物经离线包与经市场安装得到同一份挂载点。`dependencies.dsc` 会被当作清单的 `engines` 使用,必须写成单段版本范围,例如 `^1.0.0`;写成 `>=1.0.0 <2.0.0` 这类组合范围时预检同样按 `invalid-meta` 拒绝,原因说明指向 `dependencies.dsc`。

带作者签名的离线包:

1. 生成作者密钥对:`openssl genpkey -algorithm ed25519 -out author_secret.pem`,再用 `openssl pkey -in author_secret.pem -pubout -out author_pub.pem` 导出公钥。
2. 对 `plugin.js` 的字节做裸公钥分离签名:`openssl pkeyutl -sign -rawin -inkey author_secret.pem -in plugin.js -out plugin.js.author.sig` 。
3. 把 `plugin.js.author.sig` 与 `author_pub.pem` 一起放进包内,与 `meta.json`、`plugin.js` 同级。

只带其中一个文件时,引擎按未提供签名处理,并在确认对话框里提示未校验。合集侧的 CMS 签名与整站签名由合集用自己持有的 EEC 私钥完成,它覆盖 `plugin.js` 与目录数据,但不代替作者签名:作者签名由作者用自己持有的私钥签,合集只做收录与整站签名。`meta.json` 的完整性由合集的三层清单或整站清单覆盖,不需要作者签名。两套签名的约定见 [信任链与 PKI 签名](../basic/trust-chain.md) 。

## 让用户安装

| 方式 | 入口 | 清单来源 |
|:---:|:---:|:---:|
| 从地址安装 | 插件面板底部的「从地址安装」 | 产物自带的 `manifest` 导出 |
| 从本地安装 | 插件面板底部的「从本地安装」 | `meta.json` 的 `capabilities`;缺该字段时用产物自带的 `manifest`;`mounts` 缺失时同样用产物自带的 `manifest` 补齐 |
| 插件市场 | 插件面板的「插件市场」标签页 | 由该版本 `meta.json` 推导的清单优先,否则用产物自带的 `manifest`;`mounts` 缺失时用产物自带的 `manifest` 补齐 |
| 宿主注册 | 宿主代码调用 `engine.install(manifest, plugin)` | 调用方传入 |

- 通过地址安装成功后插件自动激活;安装记录写入浏览器本地,下次打开页面时自动恢复。
- 从本地安装的插件把代码文本一并存进安装记录,下次打开页面时用保存的代码恢复,不再读取离线包;离线包只需保留用于重装。
- 启动恢复只用安装时保存的代码,不再访问产物地址;单个插件恢复失败只把它标记为 `failed`,不影响其他插件与页面渲染。
- 市场索引的结构与收录要求由插件市场侧维护,产物仍须导出 `manifest`,或由索引条目内联清单。
- 卸载不会清除该插件的本地数据,`context.storage` 写入的内容在卸载后仍然保留;需要清理时由用户在设置的数据管理中执行。
- 安装时引擎用 `fetch` 取产物字节,托管方必须允许跨源取件:与页面同源时不需要额外配置;跨源时响应必须带 `Access-Control-Allow-Origin`,否则安装失败。
- 常见静态托管的默认行为:GitHub Pages 对资源返回 `Access-Control-Allow-Origin: *`,一般可以直接跨源加载;对象存储与多数 CDN 通常默认不返回该头,需要在存储桶或 CDN 侧配置 CORS 规则;不确定时用 `curl -I <产物地址>` 查看响应头里有没有 `Access-Control-Allow-Origin`。

## 常见错误与排查

安装阶段的拒绝原因:

| 原因 | 常见成因 | 处理 |
|:---:|:---:|:---:|
| `invalid-manifest` | `id`、`name`、`version` 不符合规则,或产物未导出清单且调用时未传入清单 | 修正清单字段;确保产物导出 `manifest` |
| `unknown-capability` | 申请了能力表之外的能力,或第三方插件申请 `net:fetch` | 只申请能力清单内的能力 |
| `unknown-mount` | `mounts` 不在挂载点表内 | 只使用 `session:changed` 与 `chat:before-request` |
| `incompatible-version` | `engines` 与宿主 `1.0.0` 不匹配,或写成了 `>=1.0.0 <2.0.0` 这类组合范围 | 把 `engines` 改成单段表达式 |
| `duplicate` | 同 id 插件已存在 | 先卸载旧插件再安装 |
| `missing-dependency` | `dependencies` 中的插件未安装 | 先安装依赖 |
| `conflict` | `conflicts` 中的插件已安装 | 先卸载冲突插件 |
| `artifact-unreachable` | 产物字节取不到:网络失败,或跨源托管缺少 `Access-Control-Allow-Origin` | 检查地址、网络与托管侧的 CORS 配置 |
| `load-failed` | 地址协议不支持、产物不是可存的 UTF-8 文本,或导入超过 10 秒 | 检查地址与产物格式 |
| `invalid-plugin` | 产物没有导出 `activate`,或导出形态不被识别 | 检查导出形态 |
| `missing-meta` / `missing-plugin` | 离线包根目录不是 `dist/` 的内容,或 npm 包里没有 `dist/` | 按打包要求重新生成离线包 |
| `invalid-meta` | `meta.json` 不是合法 UTF-8,缺少 `name`、`version`、`author`,版本号不是三段数字,或 `dependencies.dsc` 不是单段版本范围 | 修正 `meta.json`,版本范围写成单段表达式 |
| `corrupt-package` | 压缩包损坏,或 `plugin.js` 不是 UTF-8 文本 | 重新打包 |
| `package-too-large` | `plugin.js` 超过 2 MB | 精简产物(行压缩、去掉内联资源)后重新打包 |

签名校验不通过不属于安装拒绝:引擎仍会安装,只把该插件标记为校验失败并提示用户自行判断,重新签名后重新打包即可消除提示。

运行阶段的现象:

| 现象 | 成因 | 处理 |
|:---:|:---:|:---:|
| 状态显示「启动失败」 | `activate` 抛错或超过 5 秒 | 打开插件日志定位抛错位置 |
| 抛 `PluginCapabilityError` | 调用了未在清单申请的能力 | 在 `capabilities` 中补上 |
| 抛 `PluginRateLimitError` | 超出能力限流 | 降低调用频率或改为事件驱动 |
| 抛 `PluginTimeoutError` | 单次异步调用超过 3 秒 | 缩短单次调用耗时 |
| 抛 `PluginAbortError` | 传入的 `signal` 已取消 | 检查取消逻辑 |
| 抛 `PluginDataError` | 数据超过 64KB,或值无法 JSON 序列化 | 精简数据;移除函数、`undefined` 与循环引用 |
| 请求参数没有变化 | 处理器超过 10 毫秒预算,或抛错;越界值被裁剪 | 查看引擎日志里的 `chat:before-request` 记录,把耗时压到 10 毫秒内并检查抛错 |
| 系统提示词被整体替换 | 同时返回了 `systemPromptReplace` | 只想补充说明时改用 `systemPromptAppend` |
| 卸载被拒绝 | 有已启用的插件依赖它 | 先停用依赖方再卸载 |

## 延伸阅读

- [dsc 插件开发规范](../basic/plugin-develop-spec.md)
- [dsc 插件产物规范](../basic/plugin-product-spec.md)
- [开发文档索引](../index.md)
