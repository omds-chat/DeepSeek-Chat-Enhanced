# 信任链与合集信任签名

本文说明 dsc 如何为插件合集签发合集信任签名、什么时候必须重签、私钥的边界,以及市场如何校验这份签名。内容与 `scripts/sign-collection.mjs` 和 `src/components/dsc-market/trust.ts` 的当前实现一致,未实现的能力不写入本文。

## 信任链结构

```
dsc 私钥(WEB_PRIVATE_KEY)
├── 签网页产物每个代码文件          -> web_sign.json(signer=dsc)
└── 签合集根目录 plugin_secret.pub  -> plugin_set_sign.json(signer=dsc)

合集私钥(PLUGIN_PRIVATE_KEY)
├── 导出合集公钥                    -> plugin_secret.pub
└── 签每个插件的 meta.json 与 plugin.js -> plugin_sign.json(signer=合集名)

作者私钥(AUTHOR_SIGN_PRIVATE_KEY)
└── 对同一插件自签名                -> plugin_sign.json(signer=作者名)
```

信任链只有这三层,且不支持下级派生: 合集不能为其他合集签发信任签名。

本仓库负责链条中的第一环(dsc 签发合集信任签名)以及网页产物签名;合集为插件签名由合集自己的流水线完成,作者自签名由插件模板的构建流程完成。

## 信任签名签的是什么

| 项 | 约定 |
|:---:|:---:|
| 被签名对象 | 合集根目录 `plugin_secret.pub` 的文件字节 |
| 摘要 | SHA-512 |
| 签名 | 对摘要做 Ed25519 签名,base64 编码 |
| 签名者 | 固定为 `dsc` |
| 产物 | 合集根目录 `plugin_set_sign.json` |

产物结构(没有 `for` 字段):

```json
{
  "sign": [
    { "value": "<base64 签名>", "signer": "dsc" }
  ]
}
```

信任签名只绑定合集公钥,不绑定插件清单、插件产物或合集目录下的其他文件。插件签名由合集私钥签发,写在每个插件版本目录的 `plugin_sign.json` 中,两者作用不同、不能互相替代。

## 为合集签发信任签名

签发工具是 `scripts/sign-collection.mjs`,也可以通过 `pnpm run sign:collection` 调用。

```
WEB_PRIVATE_KEY="$(cat secret)" node scripts/sign-collection.mjs <合集目录>
WEB_PRIVATE_KEY="$(cat secret)" node scripts/sign-collection.mjs <合集目录> --out <输出路径> --force
```

| 参数 | 说明 |
|:---:|:---:|
| `<合集目录>` | 必填,含 `plugin_secret.pub` 的合集根目录 |
| `--out <输出路径>` | 可选,默认写到 `<合集目录>/plugin_set_sign.json` |
| `--force` | 目标文件已存在时覆盖旧签名,默认拒绝覆盖 |
| `--help` | 打印用法 |

前置校验与失败行为:

| 情形 | 行为 |
|:---:|:---:|
| 未设置 `WEB_PRIVATE_KEY` | 非零退出,提示缺少环境变量 |
| 私钥不是 Ed25519 | 非零退出,提示算法不符 |
| 合集目录不存在或不是目录 | 非零退出 |
| 缺少 `plugin_secret.pub` | 非零退出 |
| `plugin_secret.pub` 不是合法的 SPKI PEM | 非零退出,并给出解析失败原因 |
| `plugin_secret.pub` 是合法 SPKI 但算法不是 Ed25519 | 非零退出,提示需要 Ed25519 公钥 |
| 输出目录不存在 | 非零退出 |
| 目标文件已存在且未加 `--force` | 非零退出,提示加 `--force` |
| 目标文件已存在且加了 `--force` | 覆盖旧签名,输出中说明旧签名已被替换 |

脚本只读取 `plugin_secret.pub`,不会修改它;输出路径指向该文件时直接拒绝。写出前脚本会用由私钥推导的公钥做一次自检,自检不通过则不写出文件。

## online-data 分支

`online-data` 是与 `main` 没有公共祖先的孤立分支,只存放网页在运行时需要拉取并核对的信任数据,不含任何产品代码。

| 路径 | 说明 |
|:---:|:---:|
| `index.json` | 信任清单:列出各合集的 id、公钥路径与信任签名路径 |
| `web_public.pem` | dsc 网页签名公钥,由 `WEB_PRIVATE_KEY` 推导 |
| `collections/<合集>/plugin_secret.pub` | 受信任合集的公钥,与合集自己分发的文件逐字节一致 |
| `collections/<合集>/plugin_set_sign.json` | dsc 对该合集公钥签发的信任签名 |

生成命令在 `main` 工作树上执行,输出目录属于生成物目录:不存在时创建,已存在的同名文件直接覆盖。

```
WEB_PRIVATE_KEY="$(cat secret)" pnpm run build:online-data -- --out single-branch/online-data ../awesome-dsc-plugin ../dsc-inner-plugin
```

等价于 `node scripts/build-online-data.mjs --out <目录> <合集目录>...`,脚本按下列顺序工作:

| 步骤 | 行为 |
|:---:|:---:|
| 1 | 读取 `WEB_PRIVATE_KEY`,确认是 PKCS#8 PEM 且算法为 Ed25519,推导 SPKI PEM 公钥 |
| 2 | 逐个合集读取 `plugin_secret.pub`,确认是 Ed25519 SPKI 公钥,对文件字节做 SHA-512 摘要后签名 |
| 3 | 用推导出的公钥自检每条签名,任一条不通过即非零退出,且不写出任何文件 |
| 4 | 写出 `web_public.pem` 与 `collections/<合集>/` 下的公钥、信任签名,最后写出 `index.json` |

失败行为:

| 情形 | 行为 |
|:---:|:---:|
| 缺少 `WEB_PRIVATE_KEY` | 非零退出,提示缺少环境变量 |
| 私钥不是 Ed25519 | 非零退出,提示算法不符 |
| 没有给出合集目录 | 非零退出,提示至少需要一个 |
| 合集目录不存在或不是目录 | 非零退出 |
| 合集目录缺少 `plugin_secret.pub` | 非零退出 |
| `plugin_secret.pub` 不是 Ed25519 SPKI 公钥 | 非零退出,并给出解析失败原因 |
| 两个合集目录同名 | 非零退出,提示合集 id 必须唯一 |

`index.json` 的结构:

```json
{
  "schemaVersion": 1,
  "webPublicKey": "web_public.pem",
  "collections": [
    {
      "id": "<合集名>",
      "publicKey": "collections/<合集名>/plugin_secret.pub",
      "trustSignature": "collections/<合集名>/plugin_set_sign.json"
    }
  ]
}
```

合集 id 取自合集目录名,只允许字母、数字、点、下划线与连字符。公钥文件按原字节写出,不做重新编码,否则签名失效。

### 网页如何核对信任清单

页面启动后静默拉取 `index.json`,依次尝试 jsDelivr 的 `@online-data` 镜像与 `raw.githubusercontent.com` 的 `online-data` 分支,单个请求最多等待 1 秒:

1. 取 `web_public.pem`,与构建时注入的 `__WEB_PUBLIC_KEY__` 比对。
2. 一致才采信清单;不一致只警告,清单不参与后续校验。
3. 对每个合集取公钥与信任签名,用内嵌的 dsc 公钥验签。
4. 校验不通过的合集只警告并标记为不可信,仍然列出,不阻断市场使用。
5. `__WEB_PUBLIC_KEY__` 为空(本地未签名构建)或网络失败时静默返回空清单,不打扰用户。

市场解析来源时优先使用清单里该合集的公钥,而不是来源自己分发的 `plugin_secret.pub`,这样来源无法通过替换自己的公钥来伪造插件签名;清单未就绪或没有对应条目时,退回按来源自己的公钥与 `plugin_set_sign.json` 校验。

## 什么时候必须重签

| 情形 | 是否重签 | 原因 |
|:---:|:---:|:---:|
| 合集更换了 `plugin_secret.pub`(轮换合集私钥) | 必须 | 被签名对象变了,旧签名必然失效 |
| `plugin_set_sign.json` 缺失或损坏 | 必须 | 校验方判定为缺少信任签名 |
| 合集公钥文件被重新格式化(换行符、编码、首尾空白变化) | 必须 | 签名基于文件字节 |
| dsc 轮换 `WEB_PRIVATE_KEY` | 必须,且所有合集与网页产物都要重签 | 校验方内嵌的 dsc 公钥随之更换 |
| 新增、更新或删除插件 | 不需要 | 信任签名只绑定合集公钥 |
| 只改 `datalog.json`、`meta.json` 等目录数据 | 不需要 | 同上 |

合集公钥文件必须保持纯 ASCII 的 PEM 文本、LF 换行、不带 BOM: 校验方按文本读回后重新编码为字节再算摘要,字节层面的任何改动都会让签名失效。

## 私钥边界

| 密钥 | 可以出现在哪里 | 不得出现在哪里 |
|:---:|:---:|:---:|
| `WEB_PRIVATE_KEY`(dsc 私钥) | 组织签名环境、组织 CI 的 secrets | 合集仓库、合集 CI、Pages 产物、任何随包分发的文件 |
| `PLUGIN_PRIVATE_KEY`(合集私钥) | 合集 CI 的 secrets | 公开仓库文件、Pages 产物 |
| dsc 公钥 | 构建时注入 dsc 产物,由私钥推导 | 无需保密,但不能替代私钥 |
| 合集公钥 `plugin_secret.pub` | 合集根目录,随 Pages 分发 | 无需保密 |

签发合集信任签名是组织侧的一次操作: 合集只需要拿到已签发的 `plugin_set_sign.json` 和自己的公钥文件,不需要也不能持有 dsc 私钥。合集 CI 只用合集私钥为插件签名,不参与信任签发,因此 dsc 私钥绝不下发到合集 CI。

## 市场如何校验

市场拉取一个来源时,对每个 `base_url` 依次执行:

1. 先看 online-data 信任清单里是否有该来源对应的合集条目:先按来源 id 与名称匹配(内置来源的 id 就是合集目录名),再按公钥文本兜底。命中则直接采用清单里的公钥并视为可信,不采信来源自己分发的 `plugin_secret.pub`。
2. 清单里没有时,取 `<base_url>/plugin_secret.pub` 与 `<base_url>/plugin_set_sign.json`,它们必须与 `meta.json` 同址,不允许把 A 地址的公钥和 B 地址的签名拼在一起。
3. 把 `plugin_secret.pub` 的文本重新编码为字节,做 SHA-512 摘要。
4. 用内嵌的 dsc 公钥校验 `signer` 为 `dsc` 的每条签名,任意一条通过即视为可信。
5. 通过后,该来源的 `plugin_secret.pub` 才被信任,用于校验该来源插件的 `plugin_sign.json`。

dsc 公钥由 `rspack.config.ts` 在构建时从 `WEB_PRIVATE_KEY` 推导并注入 `__WEB_PUBLIC_KEY__`,不读取环境变量 `WEB_PUBLIC_KEY`,避免两者不一致。

| 信任状态 | 判定 | 用户可见结果 |
|:---:|:---:|:---:|
| 可信 | 某个 `base_url` 的信任签名校验通过 | 允许浏览与安装 |
| 不可信 | 签名不通过,或缺少 `plugin_set_sign.json`、`plugin_secret.pub` | 仍列出目录并保留「不可信」标识,给出警告;安装仍可进行,由用户自行判断 |
| 未校验信任 | 当前构建没有注入 dsc 公钥 | 允许浏览,安装前需要二次确认风险 |

警告文案区分两种原因: 缺少信任签名或公钥文件、信任签名校验未通过。

## 排错

| 现象 | 常见原因 |
|:---:|:---:|
| 市场显示来源不可信,原因是缺少信任签名或公钥文件 | 合集根目录缺少 `plugin_set_sign.json` 或 `plugin_secret.pub`,或两者与 `meta.json` 不同源 |
| 市场显示来源不可信,原因是信任签名校验未通过 | 合集更换公钥后没有重签,或公钥文件字节被改动 |
| 市场显示未校验信任 | 构建时没有设置 `WEB_PRIVATE_KEY`,产物里没有 dsc 公钥 |
| 签发时报缺少环境变量 | 未设置 `WEB_PRIVATE_KEY` |
| 签发时报目标文件已存在 | 已有旧签名,确认替换时加 `--force` |

## 延伸阅读

- [网页签名与运行时校验](web-signature.md)
- [dsc 插件产物规范](plugin-product-spec.md)
