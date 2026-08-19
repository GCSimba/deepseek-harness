# Agent Note：标明 profile 回退路径中损坏的 package manifest

Status: implemented

[English](2026-08-20-profile-fallback-manifest-diagnostics.md) | 中文

## 问题

`healProfilesModuleFallback` 会读取安装目录中的应用 manifest，并遍历其可解析的依赖闭包，以构建 `$DSH_HOME/profiles/node_modules`。任一位置的 `package.json` 发生畸形时，解析器只会抛出不含文件路径的裸 `SyntaxError`。一次安装可能包含数百个 manifest，因此启动失败无法指出损坏的产物，只能另行扫描整棵包目录树。

## 决策

回退遍历器通过一个私有 `readPackageManifest` helper 解析安装依赖闭包中的每个 manifest。该 helper 读取指定文件，只捕获 `JSON.parse` 失败，并抛出一条包含 manifest 绝对路径与解析器详情的 `dsh:` 诊断，同时把原始失败保留为 `cause`。

原生文件读取失败保持不变，因为 Node 已经包含请求路径与文件系统 code。该 helper 只供回退修复使用；profile manifest 与组合包层 manifest 继续保留各自现有的所有者和验证契约。

公开入口回归测试分别损坏安装锚点与一个传递依赖的 manifest。两项测试都会断言带有确切路径的诊断类型，以及保留下来的 `SyntaxError` cause。

## 考虑过的替代方案

**用同一个 catch 包裹读取与解析操作。** 否决，因为文件缺失、读取被拒和 JSON 畸形需要不同的修复方式。把三者都当成解析失败，会丢弃 Node 精确的文件系统诊断。

**让每个 manifest 读取方都改用共享解析器。** 否决，因为 profile manifest、组合包声明与回退依赖遍历分别拥有不同的验证和诊断前缀契约。仓库级解析器会扩大公共面与行为变更，却不能进一步改善这次启动失败。

**扫描安装目录并删除或修复损坏的 manifest。** 否决，因为回退修复不拥有包安装状态，在启动期间改写已安装产物会产生破坏性影响。

## 后果

畸形的应用或依赖 manifest 仍会终止回退修复，但错误现在会直接指出损坏文件的绝对路径、携带解析器详情，并保留原始 `SyntaxError` 以供结构化检查。成功遍历、依赖顺序、符号链接所有权、包导出与 profile 数据格式均保持不变。

## 相关记录

[profile 插件组合包决策](../architecture/2026-08-05-profile-plugin-bundles.md)负责安装优先的模块回退与依赖闭包遍历。[过期回退链接修复](2026-08-12-unlink-stale-profile-fallback-links.md)负责 junction 替换；本诊断边界不取代这两项决策。
