/** Directory-sync fault injection; temporary files, rename and reads stay real. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, onTestFinished, vi } from 'vitest'
import { JsonStorageBackend } from '../../src/index.ts'

const fault = vi.hoisted(() => ({ directory: '', sync: false, close: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args)
      if (args[0] !== fault.directory || args[1] !== 'r') return handle
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync') return async () => {
            if (fault.sync) throw new Error('injected directory sync failure')
            await target.sync()
          }
          if (property === 'close') return async () => {
            await target.close()
            if (fault.close) throw new Error('injected directory close failure')
          }
          const value: unknown = Reflect.get(target, property, target)
          if (typeof value !== 'function') return value
          const bound: unknown = value.bind(target)
          return bound
        },
      })
    },
  }
})

afterEach(() => {
  fault.directory = ''
  fault.sync = false
  fault.close = false
  vi.restoreAllMocks()
})

/** Own one real temporary JSON backend and drain it before deleting its root. */
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-published-failure-'))
  const backend = new JsonStorageBackend(root)
  onTestFinished(async () => {
    await backend.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, backend }
}

/** Select POSIX publication and reject only the target's parent-directory sync. */
export function injectDirectoryFailure(path: string, close = false): () => void {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  fault.directory = dirname(path)
  fault.sync = true
  fault.close = close
  return () => {
    fault.directory = ''
    fault.sync = false
    fault.close = false
    platform.mockRestore()
  }
}
