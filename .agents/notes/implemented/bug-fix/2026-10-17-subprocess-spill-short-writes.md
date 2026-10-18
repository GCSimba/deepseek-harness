# Agent Note: Complete subprocess spill writes

Status: implemented

English | [中文](2026-10-17-subprocess-spill-short-writes.zh.md)

## Problem

A successful `writeSync` call can return fewer bytes than requested. Ignoring that count loses output while retaining a spill path that consumers describe as full output. Catching exceptions alone does not detect this loss.

## Decision

`OutputCollector` appends buffers with Node's `writeFileSync` on its existing descriptor. The built-in completes partial writes without reopening, truncating, or closing that descriptor. A subsequent write error follows the existing [best-effort spill policy](../architecture/2026-09-22-fatal-diagnostics-and-crash-reports.md): discard the incomplete spill, report once, and retain the bounded memory tail.

## Alternatives considered

**Implement a separate write loop.** Node already owns buffer offsets and completion for caller-owned descriptors. A local loop would duplicate that mechanism.

**Discard every short write.** A partial write can complete successfully; treating progress as failure would unnecessarily remove recoverable output.

## Verification

Real-file tests inject partial progress during buffered replay, initial overflow, and later appends. They cover repeated short writes, UTF-8 bytes, reads before and after sealing, and a subsequent `ENOSPC` that removes the file and reports once. Each test restores the native filesystem functions and closes its descriptors before removing its private directory. Fault injection does not establish real disk-exhaustion frequency or power-loss durability.

## Consequences

An advertised spill retains every accepted byte within its cap. Partial progress adds the writes needed to complete the buffer; persistent errors retain the existing tail-only behavior. Public types, file naming, byte caps, diagnostics, and spill lifetime do not change. The tool-output spill policy and fatal-diagnostics decisions remain active; neither is superseded.
