# Agent Note: Classify explicit pi-ai server_error markers as SERVER

Status: implemented

English | [中文](2026-08-19-pi-ai-server-error-classification.zh.md)

## Problem

Some OpenAI-compatible providers report transient overloads as `Error Code server_error: Our servers are currently overloaded` without an HTTP status. pi-ai exposes that provider text as the terminal event's flattened `errorMessage`; `classifyPiAiError` recognized numeric 5xx statuses but not the explicit `server_error` marker, so the failure fell through to `PI_AI_ERROR`. The normal provider retry policy includes `SERVER` but deliberately excludes the unclassified catch-all, causing a recoverable overload to end the turn after one attempt.

## Decision

`classifyPiAiError` maps a case-insensitive, word-bounded `server_error` marker to the existing `SERVER` code. Authentication, quota, rate-limit, and explicit request-size rejection checks retain precedence, and ordinary prose containing `server` or a different marker such as `client_error` remains `PI_AI_ERROR`.

The adapter continues to report facts rather than retry instructions. `dsh-llm-retry` applies the resolved provider policy to `SERVER`, while a direct `ctx.llm.stream()` call remains single-attempt because pi-ai SDK retries stay disabled.

A classifier regression uses the reported provider wording and carries negative fixtures for generic server prose and `client_error`, keeping the match narrower than an overload-keyword heuristic.

## Alternatives considered

**Match words such as `overloaded`, `busy`, or `server`.** Rejected because those words can appear in permanent protocol, validation, and client failures. The explicit machine marker is a stronger routing signal and does not require guessing from prose.

**Add `PI_AI_ERROR` to the default retryable set.** Rejected because that bucket also contains permanent malformed-response and SDK failures. Retrying the catch-all would weaken the bounded recovery policy for every adapter failure that lacks a stable classification.

**Add another retry code for `server_error`.** Rejected because `SERVER` already represents transient provider-side failures. A second code would duplicate the existing provider-neutral taxonomy and require every policy surface to understand an upstream spelling.

## Consequences

Provider overloads carrying the explicit marker route through the existing `SERVER` policy without changing the error message, failure schema, or retry limits. Unknown wording remains non-retryable by default, and classification remains dependent on the flattened text until pi-ai forwards structured error data or the original `Error` chain.

## Related

The [pi-ai transport truncation classification](2026-07-22-pi-ai-transport-truncation-classification.md) owns the upstream flattening constraint and the eventual structured-error exit. The [bounded LLM request recovery decision](../architecture/2026-06-21-bounded-llm-request-recovery.md) owns the provider-neutral transient code set and retry-policy boundary.
