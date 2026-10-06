# Agent Note: SQLite 搜索索引中的 Session 来源

Status: implemented

[English](2026-10-06-sqlite-search-header-origin.md) | 中文

## 问题

搜索结果承诺克隆 `SessionHeader` 元数据，但从索引重建需要所有可选头部字段。父 id 不能替代 `origin`：普通 fork 与 subagent 都有父级。

## 决策

持久与实时索引行保留可为空的 `origin`，重建头部仅在该字段不存在时省略它。派生 schema 版本 9 从权威 Session 来源重建已识别的旧索引；Session 格式不变。

## 备选方案

**根据父子关系推断来源。** 这会误分类普通 fork。

**排序后逐一获取源头部。** 这会增加读取，并可能混合不同观察。

**为适配索引列而修改规范 Session 文件。** 这会颠倒派生数据的所有权。

## 影响

搜索与精确读取保留相同的头部元数据。已识别的旧索引需要重建一次，且不改写 JSONL。现有源修订、实时优先、游标失效及外部数据库拒绝规则保持有效。
