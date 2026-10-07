/** Backend-owned terminal failures invalidate cached reads before teardown completes. */
import { Context } from '@deepseek-ai/cordis'
import Storage, { StorageError } from '@deepseek-ai/dsh-storage'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { defineDomain, descriptorOf, DomainFacility, domainTable } from '../src/index.ts'
import { MemoryStorageBackend } from './helpers/memory-backend.ts'

describe.each(['update', 'delete', 'global'] as const)('%s terminal backend failure', (operation) => {
  it('reserves the name until one teardown finishes and skips queued backend calls', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const spec = defineDomain({ name: 'terminal', version: 1,
      global: { schema: z.object({ value: z.string() }), initial: { value: 'initial' } },
      tables: { t: domainTable(z.object({ value: z.string() })) } })
    const medium = new MemoryStorageBackend()
    const seed = await medium.kv.open(descriptorOf(spec))
    await seed.putRecord('t', 'k', { value: 'old' })
    await seed.close()
    const closeStarted = Promise.withResolvers<undefined>()
    const releaseClose = Promise.withResolvers<undefined>()
    const facility = new DomainFacility(ctx, { backend: 'fault' })
    onTestFinished(async () => {
      releaseClose.resolve(undefined)
      await facility.closeAll()
      await ctx.fiber.dispose()
      await medium.close()
    })
    const failure = new StorageError('closed', 'backend retired its unit')
    const put = vi.fn(async () => { throw failure })
    const remove = vi.fn(async () => { throw failure })
    const setGlobal = vi.fn(async () => { throw failure })
    const close = vi.fn(async () => {
      closeStarted.resolve(undefined)
      await releaseClose.promise
    })
    let first = true
    ctx.storage.backend.register('fault', { kv: { open: async (descriptor) => {
      const unit = await medium.kv.open(descriptor)
      if (!first) return unit
      first = false
      return {
        loadAll: () => unit.loadAll(),
        putRecord: put,
        deleteRecord: remove,
        setGlobal,
        close: async () => { await close(); await unit.close() },
      }
    } }, close: () => medium.close() })
    const domain = await facility.open(spec)
    const table = domain.table('t')
    const changes = vi.fn()
    ctx.on('domain/changed', changes)
    const failed = operation === 'update' ? table.update('k', value => value)
      : operation === 'delete' ? table.delete('k') : domain.global.set({ value: 'new' })
    const transform = vi.fn((value: { value: string }) => value)
    const queued = table.update('k', transform)
    let settled = false
    const observed = Promise.allSettled([failed, queued]).then((results) => { settled = true; return results })
    await closeStarted.promise
    expect(settled).toBe(false)
    expect(() => table.get('k')).toThrow(/closed/)
    expect(() => domain.global.get()).toThrow(/closed/)
    await expect(table.put('later', { value: 'later' })).rejects.toMatchObject({ code: 'closed' })
    await expect(facility.open(spec)).rejects.toMatchObject({ code: 'already-open' })
    const explicitClose = domain.close()
    releaseClose.resolve(undefined)
    expect(await observed).toMatchObject([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: { name: 'DomainError', code: 'closed' } },
    ])
    await Promise.all([explicitClose, domain.close()])
    expect(close).toHaveBeenCalledOnce()
    expect(put.mock.calls.length + remove.mock.calls.length + setGlobal.mock.calls.length).toBe(1)
    expect(transform).not.toHaveBeenCalled()
    expect(changes).not.toHaveBeenCalled()
    const reopened = await facility.open(spec)
    expect(reopened.table('t').get('k')).toEqual({ value: 'old' })
    await domain.close()
    expect(facility.get(spec.name)).toBe(reopened)
    await reopened.close()
  })
})

it('preserves the backend failure when teardown also rejects and keeps the name reserved', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Storage)
  const failure = new StorageError('closed', 'backend retired')
  const cleanup = new Error('unit release failed')
  const close = vi.fn(async () => { throw cleanup })
  ctx.storage.backend.register('fault', {
    kv: { open: async () => ({
      loadAll: async () => ({ tables: { t: { k: { value: 'old' } } }, global: null }),
      putRecord: async () => { throw failure },
      deleteRecord: async () => {},
      setGlobal: async () => {},
      close,
    }) },
    close: async () => {},
  })
  const facility = new DomainFacility(ctx, { backend: 'fault' })
  const spec = defineDomain({ name: 'terminal', version: 1,
    tables: { t: domainTable(z.object({ value: z.string() })) } })
  const domain = await facility.open(spec)
  const table = domain.table('t')
  const transform = vi.fn((value: { value: string }) => value)
  expect(await Promise.allSettled([table.put('k', { value: 'new' }), table.update('k', transform)])).toMatchObject([
    { status: 'rejected', reason: failure },
    { status: 'rejected', reason: { code: 'closed' } },
  ])
  await expect(domain.close()).rejects.toBe(cleanup)
  await expect(domain.close()).rejects.toBe(cleanup)
  expect(close).toHaveBeenCalledOnce()
  expect(transform).not.toHaveBeenCalled()
  expect(() => table.get('k')).toThrow(/closed/)
  await expect(facility.open(spec)).rejects.toMatchObject({ code: 'already-open' })
})
