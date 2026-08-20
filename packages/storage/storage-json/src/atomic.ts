/**
 * Atomic whole-file replacement for the JSON backend.
 *
 * Publish protocol: write a same-directory temp file, fsync it, then
 * `rename()` over the target. Rename is an atomic replace on POSIX and on
 * Windows (libuv maps it to `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`),
 * and replacement is the intended semantic here — unlike the session-log
 * backend's link()+unlink() no-clobber protocol, a unit file has exactly one
 * writer per process and last-write-wins is correct. After the rename the
 * parent directory is fsynced on POSIX so the new entry is crash-durable.
 * @module @deepseek-ai/dsh-storage-json/src/atomic
 */

import { open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** A replacement is visible, but syncing its parent directory failed. */
export class PublishedWriteDurabilityError extends Error {
  override readonly name = 'PublishedWriteDurabilityError'

  /**
   * @param path - Target whose replacement is already visible.
   * @param cause - Parent-directory synchronization failure.
   */
  constructor(path: string, cause: unknown) {
    super(`replacement for '${path}' is visible, but parent-directory durability could not be proven`, { cause })
  }
}

/**
 * Durably replace `path` with `data`.
 * @param path - Absolute target file path.
 * @param data - Full new file content.
 * @returns resolution after the replacement is crash-durable.
 */
export async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  let published = false
  try {
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
    published = true
    await fsyncDirectory(dirname(path))
  } catch (error) {
    if (published) throw new PublishedWriteDurabilityError(path, error)
    try {
      await rm(tmp, { force: true })
    } catch (_stagingCleanupFailure) {
      // The publication failed; cleanup of its private sibling must not replace the primary error.
    }
    throw error
  }
}

/** fsync a POSIX directory so a just-renamed entry is crash-durable. */
/* v8 ignore start -- Windows rejects O_RDONLY directory opens; POSIX coverage exercises this. */
async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } catch (error) {
    try {
      await handle.close()
    } catch (_directoryCloseFailure) {
      // The synchronization failure is the durability result; a failure from
      // the attempted handle cleanup must not replace its diagnostic cause.
    }
    throw error
  }
  await handle.close()
}
/* v8 ignore stop */
