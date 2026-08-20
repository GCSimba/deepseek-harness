# Agent Note: Win32 folder paths use UTF-16 code-unit termination

Status: implemented

English | [中文](2026-08-21-win32-folder-path-utf16-termination.zh.md)

## Problem

The Win32 native directory picker receives an `IShellItem` display name as a NUL-terminated UTF-16LE string. Its direct-memory decoder stopped when the low byte of a code unit was zero instead of waiting for the complete `0x0000` terminator. Valid characters such as `阀` (`U+9600`) therefore truncated a selected path before workspace adoption, while most ASCII and CJK paths concealed the defect.

The [Win32 folder dialog decision](../feature/2026-08-02-win32-in-process-folder-dialog.md) owns the koffi-backed COM implementation. This note owns decoding the selected display name returned by that implementation.

## Decision

The decoder advances through complete two-byte UTF-16LE code units and terminates only when both bytes of the current code unit are zero. It continues to view the native allocation directly because koffi's `void **` out-parameter exposes a raw address that cannot safely use pointer-dereferencing string decoding.

The selection fixture includes a character whose UTF-16LE low byte is zero. Memory release, COM object release, and COM uninitialization remain part of the same regression so path correctness does not weaken native-resource hygiene.

## Alternatives considered

- **Stop at either zero byte.** UTF-16 permits either byte of a non-NUL code unit to be zero, so this cannot distinguish text from the terminator.
- **Use `koffi.decode(address, 'str16')`.** The value is a raw address obtained through an out-parameter; treating it as the pointer container would add another dereference and can crash the dialog process.
- **Restrict or normalize selected paths.** The operating system already returned a valid absolute path. Altering user data would conceal the decoder defect and reject ordinary Windows names.

## Consequences

Windows folder selections preserve complete UTF-16 paths, including characters with a zero low byte. The RPC value, workspace identity rules, COM ABI, native allocation lifetime, and other platform pickers are unchanged. Decoding still scans within the existing bounded memory view.

## Testing

The mocked-koffi COM test selects `C:\疏水阀数据\2025年\子目录`, whose `阀` code unit contains the byte sequence `00 96`. It pins the complete result and the release of the display-name allocation, shell item, dialog, and COM apartment. Existing dialog tests continue to cover cancellation and extraction failures.
