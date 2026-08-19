# Agent Note: Transactional Win32 spawn handle ownership

Status: implemented

English | [中文](2026-08-20-windows-acl-spawn-failure-ownership.zh.md)

## Problem

The Windows ACL launcher crosses several fallible native boundaries while ownership is only partially assembled: three anonymous pipe pairs, temporary inheritance on caller-owned stdio handles, process and thread handles, a kill-on-close job, and the handles transferred to pipe-drain and process-wait operations. A failure may arrive after only a subset exists. Closing resources before capturing `GetLastError` can also replace the primary diagnostic. Without an explicit ownership boundary, these paths can retain native handles, leave stdio inheritable for an unrelated spawn, strand a partial child, or report a cleanup error instead of the operation that failed.

## Decision

`spawn.ts` owns each native resource transactionally until a complete return transfers it to the caller. Piped spawn setup creates and configures all three pipe pairs as one unit and closes every acquired pair on failure; a malformed successful `CreatePipe` result closes whichever non-null half exists. A successful process creation transfers its process and output-read handles only after both process-information handles are valid. If the process-information result is partial, the launcher terminates the returned process when present and closes every returned native handle before rejecting it.

Inherited-stdio spawn retains the kill-on-close job until the complete child result is returned. It records only stdio handles whose inherit bit was enabled successfully and restores exactly that set in a `finally` boundary. A partial process-information result receives the same terminate-and-close treatment; job assignment and thread-resume failures release the suspended child and all locally owned handles.

Pipe draining and process waiting accept ownership of their incoming handles and close them in `finally`, including failure exits. Every primary Win32 failure is converted to a `Win32Error`, or its numeric code is captured, before best-effort cleanup begins. Cleanup return values do not replace that primary error. These rules stay local to the Windows ACL spawn implementation and do not add a public handle-owner abstraction.

## Verification

Public-entry tests inject failures at pipe acquisition, pipe inheritance, stdio inheritance, process creation, malformed process information, job assignment, thread resume, pipe peek/read, process wait, and exit-code lookup. They assert the exact primary Win32 code, restoration of each enabled inherit bit, termination of a returned partial process, and closure of every locally owned handle. The same suite exercises the successful ownership transfers, command-line quoting, and top-level sandbox failure paths; focused coverage for `spawn.ts` includes every statement, branch, function, and line.

## Alternatives considered

**Introduce a generic native-handle RAII framework.** Rejected because the ownership shapes are finite and local to one module. A framework would broaden the package surface and obscure the distinct transfer points without improving these paths.

**Rely on process exit to reclaim leaked handles or inheritance state.** Rejected because the runner and host are long-lived enough for leaks and inheritable handles to affect later launches, while a suspended partial child can remain alive indefinitely.

**Let cleanup failures replace the original failure.** Rejected because the first failed operation identifies the actionable cause. Cleanup remains best-effort after that diagnostic is materialized.

**Guard only `CreateProcessAsUserW` failures.** Rejected because ownership begins during pipe or stdio setup and continues through drain and wait; failures on either side of process creation have the same resource-lifetime contract.

## Consequences

Native handles and temporary inheritance state have one local owner on every tested exit, and malformed process results cannot leave a returned child running. The primary Win32 diagnostic survives cleanup calls that mutate last-error state. Successful spawn behavior, package exports, TypeScript interfaces, configuration, and child-process I/O contracts are unchanged. Cleanup API return values remain deliberately best-effort; the launcher guarantees that every owned cleanup is attempted, not that Windows accepts every cleanup call.

## Related

The [Windows ACL restricted-token sandbox decision](../feature/2026-08-08-windows-acl-restricted-token-sandbox.md) owns the confinement mechanism, job lifetime, and inherited-stdio runner shape. This note owns only native resource lifetime across their failure paths.
