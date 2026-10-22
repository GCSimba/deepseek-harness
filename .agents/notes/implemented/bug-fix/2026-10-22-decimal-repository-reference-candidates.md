# Agent Note: Decimal data requires Git-reference syntax before commit lookup

Status: implemented

English | [中文](2026-10-22-decimal-repository-reference-candidates.zh.md)

## Problem

A decimal byte count can coincide with the abbreviated name of a locally available commit. Classifying every hexadecimal-looking token through Git therefore makes an unchanged dependency lockfile fail reference validation when the local object database gains an unrelated commit. Quoted ordinary identifiers and dates have the same ambiguity.

## Decision

The repository-reference checker treats unlabelled decimal tokens as data. A decimal token becomes a candidate only in recognized Git-reference syntax: commit or revision labels, Git revision URL paths, supported Git command operands, or revision suffixes. Tokens containing hexadecimal letters retain their existing detection. Candidate lookup still requires exactly one available object of type commit; blobs, trees, ambiguous prefixes, absent objects, and long digests retain their existing treatment.

Candidate extraction and per-line reporting use the same occurrence-level classifier. An explicit reference on one line cannot turn an ordinary byte count with the same value elsewhere into another finding. Candidate context stays line-local; this is not a complete parser for shell programs or arbitrary natural-language references.

The [single object listing](../process/2026-10-12-local-gate-speedups.md) remains the owner of prefix-resolution performance and ambiguity rules. The classifier does not fetch history or change the local object database.

## Alternatives considered

**Exclude dependency lockfiles.** A lockfile can contain a real pinned Git URL. A file-wide exemption would hide that reference and leave the same numeric collision in other files.

**Ignore every decimal commit name.** Git permits all-decimal abbreviated object names. Explicit numeric Git references still need validation, independently of their spelling.

**Keep object existence as sufficient evidence.** Object existence proves that a token can resolve, not that a byte count or date refers to that object. The finding would continue to depend on unrelated fetches and local history.

**Parse every file format completely.** Maintained inputs include prose, source, configuration, and symlink targets. A format-specific parser for every input would add substantial policy and maintenance without resolving unlabelled decimal prose.

## Consequences

Numeric data no longer becomes a prohibited reference solely because a matching commit exists locally. Bare decimal text without recognized Git-reference syntax is intentionally accepted. The rejection policy for mixed hexadecimal commit names and explicit numeric Git references remains active; there are no new path exclusions or lockfile edits.

Real temporary Git repositories exercise numeric-prefix commits, data/reference occurrences with the same value, object types, ambiguity, and missing partial-clone objects. The repository-wide command checks the unchanged lockfile against the actual local object database.
