# Agent Note：把明确的 pi-ai server_error 标记分类为 SERVER

Status: implemented

[English](2026-08-19-pi-ai-server-error-classification.md) | 中文

## 问题

有些 OpenAI 兼容提供方会用 `Error Code server_error: Our servers are currently overloaded` 报告瞬时过载，而不附带 HTTP 状态。pi-ai 把这段提供方文本作为终止事件中扁平化的 `errorMessage` 暴露出来；`classifyPiAiError` 能识别数字形式的 5xx 状态，却不识别明确的 `server_error` 标记，因此该失败落入 `PI_AI_ERROR`。提供方的 normal 重试策略包含 `SERVER`，却有意排除未分类的兜底 code，导致一次可恢复过载在首次尝试后就终结轮次。

## 决策

`classifyPiAiError` 将不区分大小写、带单词边界的 `server_error` 标记映射到现有 `SERVER` code。身份验证、配额、速率限制与明确的请求大小拒绝检查继续拥有更高优先级；只含普通 `server` 措辞或带有 `client_error` 等其他标记的文本仍归入 `PI_AI_ERROR`。

适配器继续报告事实，而不是重试指令。`dsh-llm-retry` 按解析后的提供方策略处理 `SERVER`；由于 pi-ai SDK 重试仍被禁用，直接调用 `ctx.llm.stream()` 仍只尝试一次。

分类器回归测试使用报告中的提供方措辞，并为普通 server 文本与 `client_error` 设置反例，使匹配范围小于基于过载关键词的启发式规则。

## 考虑过的替代方案

**匹配 `overloaded`、`busy` 或 `server` 等单词。** 否决，因为永久性的协议、验证和客户端失败中也可能出现这些单词。明确的机器标记是更强的路由信号，无需从自然语言措辞中猜测。

**把 `PI_AI_ERROR` 加入默认可重试集合。** 否决，因为该类别还包含永久性的畸形响应与 SDK 失败。重试兜底类别会削弱所有缺少稳定分类的适配器失败所遵循的有界恢复策略。

**为 `server_error` 新增另一种重试 code。** 否决，因为 `SERVER` 已经表示瞬时的提供方侧失败。第二种 code 会重复现有的提供方无关分类体系，并迫使每个策略表面理解一种上游拼写。

## 后果

携带明确标记的提供方过载会经由现有 `SERVER` 策略路由，且不改变错误消息、失败 schema 或重试上限。未知措辞默认仍不可重试；在 pi-ai 转发结构化错误数据或原始 `Error` 链之前，分类仍依赖扁平化文本。

## 相关记录

[pi-ai 传输层截断分类](2026-07-22-pi-ai-transport-truncation-classification.md)负责上游扁平化约束与最终的结构化错误退出路径。[有界 LLM 请求恢复决策](../architecture/2026-06-21-bounded-llm-request-recovery.md)负责提供方无关的瞬时 code 集与重试策略边界。
