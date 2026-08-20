# Agent Note: MCP tool discovery rejects repeated cursors

Status: implemented

English | [中文](2026-08-21-mcp-tools-list-repeated-cursor.zh.md)

## Problem

MCP tool discovery drains `tools/list` until the server omits its continuation cursor. A server that repeated a non-empty cursor kept the fetch loop alive, so initial activation never settled and a later `notifications/tools/list_changed` synchronization occupied its serial chain indefinitely. Empty pages avoided the duplicate-tool check and could produce unbounded protocol traffic without resolving or rejecting.

The [MCP client decision](../feature/2026-07-07-mcp-client-plugin.md) owns discovery and generation replacement. This note owns malformed pagination during that discovery.

## Decision

Each fetch phase records the non-empty continuation cursors returned by the server. Returning a cursor already seen in that phase rejects synchronization with a server-scoped error before another request uses it. The diagnostic names the protocol fault without echoing the untrusted cursor.

Repeated-cursor rejection remains a fetch-phase failure. The next generation is not installed and the previous generation stays registered. An empty cursor still ends pagination, and no arbitrary page limit rejects a finite server that emits distinct cursors.

## Alternatives considered

- **Bound the number of pages.** A fixed cap also rejects valid finite catalogs and does not identify the malformed server state that makes progress impossible.
- **Add a synchronization timeout.** A timeout limits wall time but still permits avoidable requests until it expires and introduces a deployment-varying policy unrelated to pagination correctness.
- **Trust the MCP SDK to cache pages.** Discovery deliberately issues uncached requests so output validation and generation ownership remain in this package; the package must also own its progress invariant.

## Consequences

An invalid MCP server fails discovery instead of hanging activation or later synchronization. Valid pagination and tool names are unchanged, and the guard retains at most one string per visited page for the duration of a fetch phase.

## Testing

The MCP client package test first installs a stable generation, then serves two empty pages with the same continuation cursor. It pins rejection after the second response and proves that the stable tool remains registered. The existing distinct-cursor pagination case continues to pin normal multi-page discovery.
