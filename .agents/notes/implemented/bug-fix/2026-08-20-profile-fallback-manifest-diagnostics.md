# Agent Note: Identify corrupt package manifests during profile boot

Status: implemented

English | [中文](2026-08-20-profile-fallback-manifest-diagnostics.zh.md)

## Problem

`healProfilesModuleFallback` builds `$DSH_HOME/profiles/node_modules` by reading the installation app manifest and walking its resolvable dependency closure; `loadProfile` then reads each resolved bundle package manifest. A malformed `package.json` in any of these paths raised the parser's bare `SyntaxError`, which contains no file path. An installation can contain hundreds of manifests, so the startup failure did not identify the corrupt artifact and forced a separate scan of the package tree.

## Decision

Fallback healing and bundle-layer loading parse their package manifests through one private `readPackageManifest` helper. The helper reads the named file, catches only `JSON.parse` failures, and throws a `dsh:` diagnostic containing the absolute manifest path and parser detail while retaining the original failure as `cause`.

Native file-read failures remain unchanged because Node already includes the requested path and filesystem code. The profile's own manifest remains under `readProfileManifest`, which owns its profile-specific validation and diagnostic prefix.

Public-entry regressions corrupt the installation anchor, a transitive dependency manifest, and a resolved bundle package manifest independently. Each asserts the exact path-bearing diagnostic family and the preserved `SyntaxError` cause.

## Alternatives considered

**Wrap the read and parse operations in one catch.** Rejected because a missing file, denied read, and malformed JSON need different remedies. Treating all three as parse failures would discard Node's precise filesystem diagnostic.

**Replace every manifest reader, including profile manifests, with one shared parser.** Rejected because the profile's own manifest has profile-specific validation and a bin-specific diagnostic prefix. A repository-wide parser would enlarge the public and behavioral change without improving these package-manifest failures.

**Scan the installation and delete or repair corrupt manifests.** Rejected because fallback healing does not own package installation state, and mutating installed artifacts during boot would be destructive.

## Consequences

A malformed app, dependency, or resolved bundle package manifest still stops profile startup, but the error points directly to the corrupt absolute path, carries the parser detail, and preserves the original `SyntaxError` for structured inspection. Successful traversal, dependency ordering, bundle resolution and validation, symlink ownership, package exports, and profile data formats remain unchanged.

## Related

The [profile plugin bundles decision](../architecture/2026-08-05-profile-plugin-bundles.md) owns the installation-first module fallback and dependency-closure walk. The [stale fallback link fix](2026-08-12-unlink-stale-profile-fallback-links.md) owns junction replacement; neither decision is superseded by this diagnostic boundary.
