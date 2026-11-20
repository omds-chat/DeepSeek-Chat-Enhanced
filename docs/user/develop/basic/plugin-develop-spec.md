# dsc 插件开发规范

> 本文件现在只起关联与占位作用:插件开发规范不再在本仓库维护,以模板仓库 [dsc-plugin-template](https://github.com/omds-chat/dsc-plugin-template) 的 specs 为准。
> - [dsc 插件开发规范](https://github.com/omds-chat/dsc-plugin-template/blob/main/specs/plugin-develop-spec.md):开发约束、清单字段与校验顺序、清单 id 的收敛、版本与依赖、运行时 meta、作者签名与公钥位置、分发要求
> - [dsc 插件运行时规范](https://github.com/omds-chat/dsc-plugin-template/blob/main/specs/plugin-runtime-spec.md):产物形态、导出契约、生命周期与超时、能力与限流、上下文成员、可见数据范围、插件数据、错误与降级
>
> 模板仓库同时提供清单与运行时 meta 的 JSON Schema 与零依赖校验脚本。

## 迁移说明

本文原有的开发约束、插件对象与导出清单示例、能力清单(含 `context` 成员、签名、限流与超时)、插件数据、可见数据范围、产物签名与错误处理,均已由上面两篇模板规范覆盖,口径一致,本仓库不再重复维护;其中 `context.id` 与 `context.version` 两个只读成员见模板运行时规范第 5 节。

本仓库专有的签名体系(合集 CMS 签名、三层清单签名、来源结论与信任清单判定)不在模板仓库内维护,见 [信任链与 PKI 签名](trust-chain.md) 与 [dsc 插件产物规范](plugin-product-spec.md);最小示例与打包流程见 [从零编写一个 dsc 插件](../framework/build-a-plugin.md)。
