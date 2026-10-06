# Agent Note: Desktop-entry metadata string escapes

Status: implemented

English | [中文](2026-10-06-desktop-entry-metadata-escapes.zh.md)

## Problem

Freedesktop display names and icons use string escapes, including `\s` for a space. Literal values can display escape text or fail icon lookup. Executable commands have separate quoting rules.

## Decision

The shared desktop-entry reader decodes `Name`, localized `Name` keys, and `Icon` once using the five standard string escapes. `Exec`, `TryExec`, and unrelated fields stay literal. Both application catalogs consume the same decoded metadata.

## Alternatives considered

**Decode every field.** This could alter executable quoting.

**Decode repeatedly.** This turns a literal escaped backslash followed by `s` into a space.

**Use shell or JSON unescaping.** This admits different syntax from the desktop-entry specification.

## Consequences

Legal escaped names display their intended text, and escaped icon names or paths reach normal icon lookup. Launch arguments and registration validation remain unchanged. Parser, real-file association, and Host HTTP icon tests cover the shared reader.
