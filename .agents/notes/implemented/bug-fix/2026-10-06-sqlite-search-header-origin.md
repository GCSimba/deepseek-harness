# Agent Note: Session origin in the SQLite search index

Status: implemented

English | [中文](2026-10-06-sqlite-search-header-origin.zh.md)

## Problem

Search results promise cloned `SessionHeader` metadata, but index reconstruction needs every optional header field. A parent id cannot substitute for `origin`: both ordinary forks and subagents have parents.

## Decision

Persistent and live index rows retain nullable `origin`, and reconstructed headers omit it only when absent. Derived schema version 9 rebuilds recognized older indexes from authoritative Session sources; the Session format does not change.

## Alternatives considered

**Infer origin from parenthood.** This misclassifies ordinary forks.

**Fetch each source header after ranking.** This adds reads and can mix observations.

**Mutate canonical Session files to accommodate an index column.** This would reverse the ownership of derived data.

## Consequences

Search and exact reads preserve the same header metadata. Older recognized indexes incur one rebuild without rewriting JSONL. Existing source revisions, live precedence, cursor invalidation, and foreign-database refusal remain in effect.
