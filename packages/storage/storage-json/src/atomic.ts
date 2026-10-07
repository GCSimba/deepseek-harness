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

/** Internal failure after replacement: the target is visible but directory durability is uncertain. */
export class PublishedWriteDurabilityError extends Error {
  override readonly name = 'PublishedWriteDurabilityError'

  /**
   * @param path - Published target file.
   * @param cause - Parent-directory synchronization failure.
   */
  constructor(path: string, cause: unknown) {
    super(`file '${path}' is published, but parent-directory durability could not be confirmed`, { cause })
  }
}

/**
 * Durably replace `path` with `data`.
 * @param path - Absolute target file path.
 * @param data - Full new file content.
 * @returns resolution after the replacement is crash-durable.
 * @throws {@link PublishedWriteDurabilityError} when directory synchronization fails after replacement.
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
    } catch (_cleanupFailure) {
      // Temporary-file cleanup must not replace the publication failure.
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
    } catch (_closeFailure) {
      // Preserve the synchronization failure when directory cleanup also fails.
    }
    throw error
  }
  await handle.close()
}
/* v8 ignore stop */
