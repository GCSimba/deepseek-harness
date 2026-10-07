# Agent Note: Tarball URL components in plugin installation

Status: implemented

English | [中文](2026-10-05-plugin-tarball-url-components.zh.md)

## Problem

The complete-spec archive pattern does not recognize a tarball extension followed by a query. A signed `plugin.tgz?token=…` URL can be refused before pnpm runs or classified as a Git repository by the hosted-repository heuristic.

## Decision

`parseInstallSpec` also recognizes HTTP(S) tarballs from the parsed URL's pathname before accepting a hosted Git repository. The complete-spec archive pattern remains accepted, including download endpoints whose query names the archive. The parser preserves the trimmed input as `spec`: it does not strip authentication parameters or replace the URL with its normalized serialization. Malformed HTTP(S) URLs return the existing `InvalidInstallSpecError`.

Local paths and non-HTTP Git forms retain their interpretation. The [guided installation](../architecture/2026-09-15-guided-plugin-installation.md) and [registry attribution](../architecture/2026-09-18-plugin-install-registries.md) decisions remain independent: pnpm owns fetching and authentication, and the source host still owns its download failures.

## Verification

Parser tests cover signed URLs, multiple path depths, both archive extensions, fragments, host ports, existing query-named download endpoints, and refusals outside the supported spec forms. The Loader-backed manager tests pin tarball inspection without a package lookup; registry tests pin source-host attribution. A keyless assembled Web scenario compares the installation dialog's ARIA and checks that the external package-manager process receives the complete URL, then cancellation preserves the profile manifest and stops the child process.

## Alternatives considered

**Strip the query before passing the spec to pnpm.** Rejected: signed downloads require those parameters, and URL normalization can alter the supplied address. Only classification uses the parsed pathname.

**Use only the pathname to identify tarballs.** Rejected: fetchable endpoints such as `/download?file=plugin.tgz` do not expose the archive extension in their pathname. The existing complete-spec pattern and pnpm accept them.

**Keep only the complete-spec archive pattern.** Rejected: a query after the archive extension prevents that pattern from matching. The parsed pathname identifies these tarballs without changing the address handed to pnpm.

## Consequences

Signed HTTP tarballs reach installation without changing public types, dependencies, package exports, or profile formats. Recognition does not prove the remote file is an archive or a valid bundle; pnpm fetching and the existing post-install validation still decide that.
