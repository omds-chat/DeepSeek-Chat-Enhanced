# 开发文档

本文是 dsc 开发文档的索引。

```
docs/user/develop/
├── index.md                    # 开发文档索引
├── basic/
│   ├── plugin-develop-spec.md  # dsc 插件开发规范
│   └── plugin-product-spec.md  # dsc 插件产物规范
└── framework/
    └── build-a-plugin.md       # 从零编写一个 dsc 插件
```

| 文档 | 说明 |
|:---:|:---:|
| [dsc 插件开发规范](basic/plugin-develop-spec.md) | 插件对象、清单字段、能力清单、可见数据范围与错误处理的约定 |
| [dsc 插件产物规范](basic/plugin-product-spec.md) | 产物形态、导出契约、加载方式、安装持久化与降级行为 |
| [从零编写一个 dsc 插件](framework/build-a-plugin.md) | 最小可运行示例、能力清单、本地验证、产物发布与安装方式 |

初次编写插件时,先读开发规范,再按入门文档完成第一个插件。
