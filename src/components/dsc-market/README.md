# dsc-market

`dsc-market` 是 dsc 的内置插件，负责拉取外源插件索引、校验结构、缓存到浏览器本地，并对外提供查询。它不渲染任何界面，后续插件市场页面通过 `market()` 取用。

## 目录结构

```
dsc-market/
├── index.ts   # 插件对象与清单导出（activate / deactivate）
├── types.ts   # 索引条目与查询结果类型
├── client.ts  # 索引拉取、校验、缓存、离线降级
└── README.md  # 机制说明
```

## 清单

| 字段 | 值 |
|:---:|:---:|
| `id` | `dsc-market` |
| `version` | `1.0.0` |
| `engines` | `^1.0.0` |
| `capabilities` | `net:fetch`、`plugins:storage` |

`net:fetch` 只对内置插件开放，因此该插件必须由 `dsc-plugin-engine` 的 `builtin.ts` 装载，作为外部插件安装会因 `unknown-capability` 被拒绝。

## 索引格式

默认地址为 `https://omdsc-dev.github.io/awesome-dsc-plugin/index.json`，该站点尚未上线，当前拉取属于预期失败。索引为 JSON 对象：

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "id": "demo-plugin",
      "name": "Demo",
      "version": "0.1.0",
      "description": "示例插件",
      "author": "omdsc-dev",
      "homepage": "https://example.com/demo",
      "download": "https://example.com/demo.js",
      "manifest": {}
    }
  ]
}
```

| 字段 | 必填 | 规定 |
|:---:|:---:|:---:|
| `schemaVersion` | 是 | 数字，当前只接受 `1` |
| `plugins` | 是 | 数组 |
| `plugins[].id` | 是 | 非空字符串 |
| `plugins[].name` | 是 | 非空字符串 |
| `plugins[].version` | 是 | 非空字符串 |
| `plugins[].description` | 是 | 字符串，可为空 |
| `plugins[].author` | 是 | 字符串，可为空 |
| `plugins[].homepage` | 是 | 字符串，可为空 |
| `plugins[].download` | 是 | 字符串，可为空 |
| `plugins[].manifest` | 否 | 内联完整清单，形态不符时该条目的 `manifest` 被丢弃 |

单条缺字段或类型不符时只跳过该条并计入 `skipped`，不影响整份索引。顶层结构不符（不是对象、`schemaVersion` 不是 1、`plugins` 不是数组）视为整份索引无效。

## 缓存与降级

| 情形 | 行为 |
|:---:|:---:|
| 缓存未过期（6 小时内） | 直接使用缓存，不发起请求 |
| 缓存过期后拉取成功 | 覆盖缓存，状态 `ready` |
| 网络失败或超时 | 回退到旧缓存，状态 `stale`，`error` 为 `pluginIndexFetchFailed` |
| 解析失败或结构不符 | 回退到旧缓存，状态 `stale`，`error` 为 `pluginIndexInvalid` |
| 无缓存且失败 | 返回空列表，状态 `stale`，同上 `error` |

所有失败都收敛成状态，不向宿主抛出，也不弹提示。缓存写入失败（例如超过 `plugins:storage` 的 64KB 上限）不影响本次查询结果。

索引地址可在 `plugins:storage` 中改写：写入键 `index-url`，值为 `{ "url": "https://..." }`，只接受 https，否则退回默认地址。

## 对外接口

```ts
import { market } from '../dsc-market/index.js'

const client = market()
await client?.refresh()        // 按 6 小时有效期拉取，force 为 true 时强制重拉
client?.list('keyword')        // 列表，可按 id、名称、描述过滤
client?.get('demo-plugin')     // 按 id 取单条
client?.status()               // { state, fetchedAt, total, skipped, error }
client?.url()                  // 当前生效的索引地址
```

`list`、`get`、`status`、`url` 是同步快照，返回当前内存中的结果；`refresh` 是唯一的异步入口，并发调用会复用同一个请求。`status().error` 是文案键而不是文案本身，界面侧用宿主 i18n 翻译。
