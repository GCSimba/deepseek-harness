import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { runKvBackendContract } from '../../storage/tests/contract.ts'
import { Config, JsonStorageBackend, apply } from '../src/index.ts'
import * as InvariantCompanion from '../src/invariant.ts'

const directorySyncFault = vi.hoisted(() => ({ enabled: false, closeFailure: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    open: async (path: string, flags: string, mode?: number) => {
      const handle = await original.open(path, flags, mode)
      if (!directorySyncFault.enabled || flags !== 'r') return handle
      return new Proxy(handle, {
        get(target, property, receiver): unknown {
          if (property === 'sync') {
            return async () => { throw new Error('injected parent-directory sync failure') }
          }
          if (property === 'close' && directorySyncFault.closeFailure) {
            return async () => {
              await target.close()
              throw new Error('injected parent-directory close failure')
            }
          }
          const value: unknown = Reflect.get(target, property, receiver)
          return typeof value === 'function'
            ? (...args: unknown[]): unknown => Reflect.apply(value, target, args) as unknown
            : value
        },
      })
    },
  }
})

const roots: string[] = []

function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined
  return Reflect.get(error, 'code') as unknown
}

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-storage-json-'))
  roots.push(root)
  return root
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

runKvBackendContract('json', async () => {
  const root = await freshRoot()
  return {
    backend: new JsonStorageBackend(root),
    reopen: async () => new JsonStorageBackend(root),
  }
})

describe('json backend specifics', () => {
  const descriptor = { name: 'shape', version: 1, tables: ['t'], hasGlobal: true }

  it('publishes a human-readable pretty-printed file', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'k', { hello: 'world' })
    const text = await readFile(join(root, 'shape.json'), 'utf8')
    expect(text).toBe(`${JSON.stringify(
      { unit: { name: 'shape', version: 1 }, global: null, tables: { t: { k: { hello: 'world' } } } },
      null,
      2,
    )}\n`)
    await backend.close()
  })

  it('defers materialization until the first write', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    await backend.kv.open(descriptor)
    await expect(readFile(join(root, 'shape.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await backend.close()
  })

  it('rejects a malformed medium', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'shape.json'), 'not json at all', 'utf8')
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects a foreign unit header', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'shape.json'),
      JSON.stringify({ unit: { name: 'other', version: 1 }, global: null, tables: {} }),
      'utf8',
    )
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects double-open of one unit as a plain caller error', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    await backend.kv.open(descriptor)
    await expect(backend.kv.open(descriptor)).rejects.toThrow(/already open/)
    await backend.close()
  })

  it('rolls back memory when a publish fails', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'k', { v: 'committed' })
    await unit.setGlobal({ g: 'committed' })
    const path = join(root, 'shape.json')
    const backup = join(root, 'shape.committed.json')
    // A directory at the publish target rejects atomic replacement on every host.
    await rename(path, backup)
    await mkdir(path)
    await expect(unit.putRecord('t', 'k', { v: 'rejected' })).rejects.toThrow()
    await expect(unit.putRecord('t', 'k2', { v: 'also rejected' })).rejects.toThrow()
    await expect(unit.deleteRecord('t', 'k')).rejects.toThrow()
    await expect(unit.setGlobal({ g: 'rejected' })).rejects.toThrow()
    await rm(path, { recursive: true })
    await rename(backup, path)
    const snapshot = await unit.loadAll()
    expect(snapshot.tables['t']).toEqual({ k: { v: 'committed' } })
    expect(snapshot.global).toEqual({ g: 'committed' })
    // The next successful publish must not carry rejected writes to disk.
    await unit.putRecord('t', 'k3', { v: 'later' })
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('rejected')
    await backend.close()
  })

  it('retires the unit when directory durability fails after publication', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    const path = join(root, 'shape.json')
    let restorePlatform = () => {}
    try {
      await unit.putRecord('t', 'k', { value: 'old' })
      // Only the POSIX directory-sync branch is forced; temp creation,
      // replacement, and target reads still use the real filesystem.
      const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
      restorePlatform = () => { platform.mockRestore() }
      directorySyncFault.enabled = true
      directorySyncFault.closeFailure = true
      const failure = await unit.putRecord('t', 'k', { value: 'new' }).then(
        () => undefined,
        (error: unknown) => error,
      )
      directorySyncFault.enabled = false
      directorySyncFault.closeFailure = false
      restorePlatform()
      restorePlatform = () => {}

      const memoryAfterFailure = await unit.loadAll().then(
        value => ({ status: 'resolved' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      )
      const diskAfterFailure = JSON.parse(await readFile(path, 'utf8')) as unknown
      const laterWrite = await unit.putRecord('t', 'later', { value: true }).then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      )
      const diskAfterLaterWrite = JSON.parse(await readFile(path, 'utf8')) as unknown

      expect({
        failure: failure instanceof Error
          ? {
            name: failure.name,
            code: errorCode(failure),
            causeName: failure.cause instanceof Error ? failure.cause.name : undefined,
            rootCause: failure.cause instanceof Error && failure.cause.cause instanceof Error
              ? failure.cause.cause.message
              : undefined,
          }
          : failure,
        memoryAfterFailure: memoryAfterFailure.status === 'rejected'
          ? { status: memoryAfterFailure.status, code: errorCode(memoryAfterFailure.error) }
          : memoryAfterFailure,
        diskAfterFailure,
        laterWrite: laterWrite.status === 'rejected'
          ? { status: laterWrite.status, code: errorCode(laterWrite.error) }
          : laterWrite,
        diskAfterLaterWrite,
      }).toEqual({
        failure: {
          name: 'StorageError',
          code: 'closed',
          causeName: 'PublishedWriteDurabilityError',
          rootCause: 'injected parent-directory sync failure',
        },
        memoryAfterFailure: { status: 'rejected', code: 'closed' },
        diskAfterFailure: {
          unit: { name: 'shape', version: 1 },
          global: null,
          tables: { t: { k: { value: 'new' } } },
        },
        laterWrite: { status: 'rejected', code: 'closed' },
        diskAfterLaterWrite: {
          unit: { name: 'shape', version: 1 },
          global: null,
          tables: { t: { k: { value: 'new' } } },
        },
      })

      const reopened = await backend.kv.open(descriptor)
      expect(await reopened.loadAll()).toEqual({
        tables: { t: { k: { value: 'new' } } },
        global: null,
      })
      await reopened.putRecord('t', 'later', { value: true })
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        tables: { t: { k: { value: 'new' }, later: { value: true } } },
      })
    } finally {
      directorySyncFault.enabled = false
      directorySyncFault.closeFailure = false
      restorePlatform()
      await backend.close()
    }
  })

  it('rejects undeclared table and global access as caller errors', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open({ name: 'shape', version: 1, tables: ['t'], hasGlobal: false })
    await expect(unit.putRecord('undeclared', 'k', {})).rejects.toThrow(/does not declare table/)
    await expect(unit.setGlobal({})).rejects.toThrow(/does not declare a global slot/)
    await backend.close()
  })

  it('rejects invalid unit and table names', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open({ ...descriptor, name: 'Bad-Name' })).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
    await expect(backend.kv.open({ ...descriptor, tables: ['ok', 'not ok'] })).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
    await backend.close()
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'closed' })
  })

  it('opens a file missing a declared table as that table empty', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'contract_unit.json'),
      JSON.stringify({ unit: { name: 'contract_unit', version: 3 }, global: null, tables: { alpha: { k: 1 } } }),
      'utf8',
    )
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open({ name: 'contract_unit', version: 3, tables: ['alpha', 'beta'], hasGlobal: true })
    const snapshot = await unit.loadAll()
    expect(snapshot.tables['alpha']).toEqual({ k: 1 })
    expect(snapshot.tables['beta']).toEqual({})
    await backend.close()
  })

  it('propagates non-ENOENT read failures', async () => {
    const root = await freshRoot()
    const { mkdir } = await import('node:fs/promises')
    // A directory where the unit file should be: readFile fails with EISDIR.
    await mkdir(join(root, 'shape.json'))
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'EISDIR' })
    await backend.close()
  })

  it('rejects malformed table shapes and foreign versions distinctly', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'shape.json'),
      JSON.stringify({ unit: { name: 'shape', version: 1 }, global: null, tables: { t: ['not', 'an', 'object'] } }),
      'utf8',
    )
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })

    await writeFile(
      join(root, 'shape.json'),
      JSON.stringify({ unit: { name: 'shape', version: 9 }, global: null, tables: {} }),
      'utf8',
    )
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'version-mismatch' })

    await writeFile(join(root, 'shape.json'), JSON.stringify({ unit: { name: 'shape', version: 1 }, global: null }), 'utf8')
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })

    await writeFile(join(root, 'shape.json'), JSON.stringify('just a string'), 'utf8')
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('registers on the hub via apply and closes on dispose', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(Storage)
    const fiber = await ctx.plugin({ apply, Config, inject: ['storage'] }, { root })
    const backend = ctx.storage.backend.get('json')
    expect(ctx.get(storageBackendServiceKey('json'))).toBe(backend)
    const unit = await backend.kv!.open(descriptor)
    await unit.putRecord('t', 'k', { v: 1 })
    await fiber.dispose()
    expect(() => ctx.storage.backend.get('json')).toThrow()
    expect(ctx.get(storageBackendServiceKey('json'))).toBeUndefined()
    await expect(unit.putRecord('t', 'x', {})).rejects.toMatchObject({ code: 'closed' })
  })

  it('registers the invariant companion and disposes cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(InvariantCompanion)
    // Disposal releases the reservation: a fresh mount succeeds.
    await fiber.dispose()
    await ctx.plugin(InvariantCompanion)
  })

  it('close drains in-flight writes and blocks in-flight opens', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    const bigWrite = unit.putRecord('t', 'big', { blob: 'x'.repeat(4 * 1024 * 1024) })
    await unit.close()
    await expect(bigWrite).resolves.toBeUndefined()
    const onDisk = JSON.parse(await readFile(join(root, 'shape.json'), 'utf8')) as {
      tables: Record<string, Record<string, unknown>>
    }
    expect(onDisk.tables['t']?.['big']).toBeDefined()

    const backend2 = new JsonStorageBackend(root)
    const opening = backend2.kv.open(descriptor)
    const closing = backend2.close()
    await expect(opening.then(u => u.putRecord('t', 'x', {}))).rejects.toMatchObject({ code: 'closed' })
    await closing
  })
})
