# Agent Note: Terminal recovery after an indeterminate JSON publication

Status: implemented

English | [中文](2026-08-21-storage-json-post-publish-durability-failure.zh.md)

## Problem

On POSIX, `rename()` exposes a complete replacement before parent-directory synchronization proves crash durability. A `single` JSON unit that rolls memory back after this replacement holds old state while the medium contains new state; its next whole-file write can silently overwrite the replacement. A `per-record` unit has no cache, but its domain retains the old cache when the backend rejects. Legacy bootstrap also publishes record documents during `loadAll()` and can reach the same failure point.

The visibility/durability distinction also governs [Windows JSONL publication](../../../../packages/session/session-persistence-jsonl/src/win32.ts). Mutable JSON units additionally need a safe rule for their live handles after reporting the failure.

## Decision

`writeAtomic()` classifies a directory failure after successful replacement as `PublishedWriteDurabilityError`, retaining the original cause. A simultaneous directory-handle close failure cannot replace the synchronization error. Failures before replacement retain ordinary cleanup and rollback semantics; temporary-file cleanup is best-effort and cannot replace the original failure.

Both JSON layouts use one internal lifetime controller. A post-publication failure blocks new operations, drains admitted I/O, releases the backend open slot once, and rejects with `StorageError('closed')` carrying the classified error. The `single` unit does not restore stale memory after replacement. The `per-record` unit applies the same retirement rule to writes and legacy initialization. Reopening reloads the actual medium.

The domain classifies `StorageError('closed')` only around concrete `KvUnit` write calls. That rejection invalidates cached reads and new writes immediately. Queued jobs skip caller transforms, the chain drains, and the facility releases the name after the unit closes successfully. Failing operations await teardown without replacing their original errors; a release failure keeps the name reserved and is exposed by explicit `Domain.close()`, which shares that teardown. An `update` transform throwing the same error remains a caller failure; other write errors leave the domain retryable.

JSON formats, domain schemas, configuration, package exports, dependencies and public TypeScript types remain unchanged. The existing `closed` code represents a terminal handle without adding a public error code.

## Verification

Real-file fault injection covers both layouts, record replacement, global replacement, single-layout deletion and per-record legacy initialization. Tests preserve the synchronization cause despite a simultaneous close failure, reject use of old handles, reopen immediately, and retain published values through later unrelated writes. Pre-publication failures remain retryable. Deterministic lifecycle tests hold teardown behind barriers, race concurrent publications with explicit close, reject queued transforms, suppress change events, and retain name ownership until one teardown completes. A caller-transform negative control keeps a healthy domain usable. Independent POSIX processes boot the storage plugins through Loader and a test-only `cordis.yml`, inject only directory synchronization failure, and verify published files and fresh domain reads on both layouts.

## Alternatives considered

**Roll memory back and keep the handle live.** The medium already exposes the replacement, so the next whole-file write can erase it.

**Report synchronization failure as success.** Visibility alone does not satisfy the backend's durability promise.

**Keep the new unit cache but reject without retiring.** The domain would retain its old cache, leaving two live owners with incompatible values.

**Publish the old state as compensation.** A second replacement can fail at the same synchronization step; without a journal it cannot restore transactional certainty.

**Classify every queue-level `closed` error as a backend failure.** Caller transforms can throw that error without retiring the backend. Classification belongs at the actual backend call.

## Consequences

A post-publication POSIX directory failure terminates the affected handles instead of permitting stale writes. Recovery requires reopening from the medium, which may contain the replacement whose crash durability was not confirmed. Successful operations retain the existing publication protocol; pre-publication failures remain retryable. Fault injection proves live-process consistency, not behavior during a real power loss; Windows write-through and the existing partial legacy-bootstrap policy are unchanged.

The scoped Agent Note audit retains the [dependency rejection record](../../rejected/simplification/2026-07-26-dependency-swaps-rejected-by-nih-audit.md) because publication durability still constrains dependency choice, and the [storage recovery proposal](../../proposed/architecture/2026-07-28-storage-root-and-derived-medium-recovery.md) because medium damage recovery is separate from retiring a live handle. Neither record is archived or deleted; Windows publication remains unchanged.
