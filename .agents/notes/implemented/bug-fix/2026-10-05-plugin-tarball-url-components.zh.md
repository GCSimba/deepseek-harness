# Agent Note: 插件安装中的 tarball URL 组成部分

Status: implemented

[English](2026-10-05-plugin-tarball-url-components.md) | 中文

## 问题

完整 spec 的压缩包模式无法识别扩展名后带查询的 tarball。带签名的 `plugin.tgz?token=…` URL 可能在 pnpm 运行前被拒绝，也可能被托管仓库启发式规则归为 Git 仓库。

## 决策

`parseInstallSpec` 也根据解析后 URL 的路径识别 HTTP(S) tarball，再接受托管 Git 仓库。完整 spec 的压缩包模式仍被接受，包括在查询中指定压缩包名称的下载入口。解析器将去除首尾空白的输入保留为 `spec`：它不会删除认证参数，也不会用规范化序列化结果替换 URL。格式错误的 HTTP(S) URL 返回现有的 `InvalidInstallSpecError`。

本地路径和非 HTTP Git 形式保持原有解释。[引导式安装](../architecture/2026-09-15-guided-plugin-installation.zh.md)与[注册表归因](../architecture/2026-09-18-plugin-install-registries.zh.md)的决策仍独立成立：pnpm 拥有抓取与认证职责，下载失败仍归于来源主机。

## 验证

解析测试覆盖签名 URL、多种路径深度、两种压缩包扩展名、片段、主机端口、原有查询指定压缩包名称的下载入口，以及支持的 spec 形式之外的拒绝行为。基于 Loader 的管理器测试固定不查询包信息的 tarball 检查行为；注册表测试固定来源主机归因。无需密钥的完整 Web 场景比较安装弹窗的 ARIA，检查外部包管理器进程收到完整 URL，并确认取消后 profile manifest（元数据清单）保持不变且子进程已停止。

## 备选方案

**传给 pnpm 前删除查询。** 拒绝：签名下载需要这些参数，URL 规范化也可能改变提供的地址。只有分类使用解析后的路径。

**只用路径识别 tarball。** 拒绝：`/download?file=plugin.tgz` 等可抓取的入口不在路径中暴露压缩包扩展名。现有完整 spec 模式和 pnpm 都接受这些入口。

**只保留完整 spec 的压缩包模式。** 拒绝：扩展名后带查询会使该模式无法匹配。解析后的路径可以识别这些 tarball，而不改变传给 pnpm 的地址。

## 影响

带签名的 HTTP tarball 可以进入安装流程，公共类型、依赖、包导出和 profile 格式均不变化。识别结果不证明远端文件是压缩包或有效组合包；pnpm 抓取和现有安装后验证仍负责判定。
