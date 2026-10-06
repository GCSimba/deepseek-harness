# Agent Note: Overlapping literal edit matches

Status: implemented

English | [中文](2026-10-06-overlapping-literal-edit-matches.zh.md)

## Problem

A literal edit without `replaceAll` promises one unique target. Searching only after each match's end misses another start inside that match and can accept an ambiguous edit.

## Decision

The string editor and local filesystem count every possible start when validating uniqueness. Replace-all consumes non-overlapping matches, and its result count measures actual replacements rather than possible starts.

## Alternatives considered

**Use one overlapping count for both modes.** This would overstate replace-all results.

**Accept the first match.** This would require a separate selection policy that neither single-edit interface exposes.

## Consequences

Ambiguous requests fail before publication and leave the file unchanged. Literal matching, line-ending policies, successful edits, and replace-all output remain unchanged. Regression coverage must distinguish overlapping ambiguity from non-overlapping replacement counts.
