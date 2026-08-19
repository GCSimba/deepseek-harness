# Agent Note: Identify corrupt profile fallback package manifests

Status: implemented

English | [中文](2026-08-20-profile-fallback-manifest-diagnostics.zh.md)

## Problem

`healProfilesModuleFallback` builds `$DSH_HOME/profiles/node_modules` by reading the installation app manifest and then walking its resolvable dependency closure. A malformed `package.json` at either point raised the parser's bare `SyntaxError`, which contains no file path. An installation can contain hundreds of manifests, so the startup failure did not identify the corrupt artifact and forced a separate scan of the package tree.

## Decision

The fallback walker parses every installation-closure manifest through one private `readPackageManifest` helper. The helper reads the named file, catches only `JSON.parse` failures, and throws a `dsh:` diagnostic containing the absolute manifest path and parser detail while retaining the original failure as `cause`.

Native file-read failures remain unchanged because Node already includes the requested path and filesystem code. The helper is private to fallback healing; profile manifests and bundle-layer manifests keep their existing owners and validation contracts.

Public-entry regressions corrupt the installation anchor and a transitive dependency manifest independently. Both assert the exact path-bearing diagnostic family and the preserved `SyntaxError` cause.

## Alternatives considered

**Wrap the read and parse operations in one catch.** Rejected because a missing file, denied read, and malformed JSON need different remedies. Treating all three as parse failures would discard Node's precise filesystem diagnostic.

**Replace every manifest reader with a shared parser.** Rejected because profile manifests, bundle declarations, and the fallback dependency walk impose different validation and diagnostic-prefix contracts. A repository-wide parser would enlarge the public and behavioral change without improving this startup failure.

**Scan the installation and delete or repair corrupt manifests.** Rejected because fallback healing does not own package installation state, and mutating installed artifacts during boot would be destructive.

## Consequences

A malformed app or dependency manifest still stops fallback healing, but the error now points directly to the corrupt absolute path, carries the parser detail, and preserves the original `SyntaxError` for structured inspection. Successful traversal, dependency ordering, symlink ownership, package exports, and profile data formats remain unchanged.

## Related

The [profile plugin bundles decision](../architecture/2026-08-05-profile-plugin-bundles.md) owns the installation-first module fallback and dependency-closure walk. The [stale fallback link fix](2026-08-12-unlink-stale-profile-fallback-links.md) owns junction replacement; neither decision is superseded by this diagnostic boundary.
