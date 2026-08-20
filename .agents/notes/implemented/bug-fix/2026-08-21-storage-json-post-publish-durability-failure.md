# Agent Note: Terminal recovery after an indeterminate JSON publication

Status: implemented

English | [中文](2026-08-21-storage-json-post-publish-durability-failure.zh.md)

## Problem

On POSIX, `rename()` makes a complete replacement visible before a subsequent parent-directory `fsync()` proves that the namespace change is crash-durable. The JSON storage unit treated every publication rejection as a pre-publication failure: it restored its in-memory mutation even when `rename()` had already replaced the file. The live unit then held the old state while the medium held the new state, and its next whole-file publication could overwrite the visible replacement with that stale state.

This failure point is the same durability distinction recorded for [Windows JSONL publication](../architecture/2026-07-05-windows-jsonl-durable-publish.md), but a mutable whole-file unit also needs a live-state recovery rule after the failure is reported.

## Decision

`writeAtomic()` classifies a parent-directory synchronization failure after successful replacement as `PublishedWriteDurabilityError`. A simultaneous directory-handle close failure does not replace the synchronization failure carried as its cause. Failures before replacement retain ordinary cleanup and rollback semantics.

A JSON unit receiving that post-publication error keeps the published mutation in its private state, terminally closes, drains already-started publications, releases its backend open slot, and rejects with `StorageError('closed')` carrying the classified error as its cause. No caller can read or publish the unit's uncertain cached state again.

The domain classifies `StorageError('closed')` only around concrete `KvUnit` write calls. That backend rejection makes cached reads and new writes fail immediately; queued jobs skip caller transforms, the write chain drains, `unit.close()` completes once, and only then does the facility release the domain name. The failing and queued operations wait for that teardown before settling, while explicit `Domain.close()` shares the same promise. An `update` transform that throws the same public error code remains a caller failure and does not retire a healthy unit. Other write failures remain recoverable: domain memory stays unchanged and later queued writes continue.

The JSON document format, domain schemas, configuration, package exports, dependencies, and public TypeScript types remain unchanged. The existing `closed` code represents the terminal handle state without adding another public error code.

## Verification

Real-file fault injection replaces the target, fails parent-directory synchronization and handle cleanup, and proves that the synchronization error remains the root cause, the old unit closes, the target retains the new value, a fresh unit reloads that value, and a later successful publication preserves it. Domain tests hold terminal unit cleanup behind a barrier and prove that cached reads and queued writes stop, the facility name remains reserved until one teardown completes, no change event is emitted, and reopening the same domain succeeds. A negative control throws `StorageError('closed')` from an `update` transform and proves that the domain remains readable, writable, and reserved. Existing pre-publication failure coverage keeps the recoverable rollback path distinct.

## Alternatives considered

**Roll memory back and keep the unit live.** This recreates the defect: the medium already exposes the replacement, so the next whole-file write can silently erase it.

**Report the directory synchronization failure as success.** The backend promises durability once a call resolves. Visibility does not prove crash durability, so resolving would weaken that promise without telling callers.

**Keep the new unit memory but reject the write.** The domain updates its own cache only after backend success and would retain the old value. Two live caches would still disagree, and subsequent domain writes could not reconcile them safely.

**Publish the old state again as compensation.** The first replacement has crossed the visibility point, and a compensating replacement can fail at the same directory synchronization step. A second publication cannot restore transactional certainty without a journal.

**Classify every `StorageError('closed')` leaving the domain queue as a backend failure.** The queued job also runs caller-provided `update` transforms, which can throw the same public error type without changing the unit lifecycle. Classification belongs around the exact backend call that owns the terminal state.

## Consequences

A rare POSIX directory synchronization failure turns the affected unit and domain handles into explicit terminal failures instead of allowing silent data overwrite. Recovery requires reopening from the medium, which may contain the complete replacement whose crash durability could not be proven. Ordinary failures before replacement remain retryable, and successful writes retain their existing behavior and cost.
