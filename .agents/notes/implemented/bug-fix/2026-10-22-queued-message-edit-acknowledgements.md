# Agent Note: Queue edit acknowledgements belong to one draft revision

Status: implemented

English | [中文](2026-10-22-queued-message-edit-acknowledgements.zh.md)

## Problem

QueueDock keeps its inline editor editable while an asynchronous queue edit is pending. Closing that editor unconditionally on success discards text entered after submission, although the Host saved only the submitted text. Disabled action buttons also do not prevent the editor's Enter handler from submitting another mutation.

## Decision

Capture the immutable edit object at submission and clear local editing state only if that same object is still current when the request succeeds. Every input change creates a new revision, even when the user returns to the submitted text. Preserve later edits for an explicit save rather than silently submitting them.

One component-owned synchronous latch admits at most one queue mutation until its promise settles; rendered busy state remains the button and expansion indicator. Failure releases the latch and preserves the latest draft for retry. Explicit cancellation and authoritative queue retirement retain their existing behavior and never resurrect an editor on completion.

## Alternatives considered

- Disable typing during saves: avoids the acknowledgement race but interrupts editing throughout network latency.
- Compare only the current text with submitted text: loses revision identity when the user edits away and back to the same value.
- Guard only with React busy state: leaves repeated keyboard actions before the next render unguarded.
- Automatically save later edits: changes explicit save intent and can mutate a queued message without another confirmation.

## Consequences

The fix stays in the queue UI owner. Host queue semantics, public types, RPC fields, Session events, and persisted formats do not change. A later draft remains local and can still be canceled or removed when its queued row retires; this is not draft persistence across reloads.

Component regressions cover later revisions, repeated saves, failure and retry, cancellation, and retirement. The recorded queue-actions browser scenario delays a real Host edit response, retains later input, and verifies the explicitly saved text reaches the durable user message.
