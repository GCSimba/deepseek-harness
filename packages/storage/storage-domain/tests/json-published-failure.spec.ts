/** Domain retirement after real JSON publication on either backend layout. */
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { defineDomain, domainTable, DomainFacility } from '../src/index.ts'
import { z } from 'zod'
import { fixture, injectDirectoryFailure } from '../../storage-json/tests/helpers/publication-fault.ts'

describe.each(['single', 'per-record'] as const)('%s JSON domain publication', (layout) => {
  it('retires the domain without emitting a change or running queued transforms', async () => {
    const { root, backend } = await fixture()
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(Storage)
    ctx.storage.backend.register('json', backend)
    const facility = new DomainFacility(ctx, { backend: 'json' })
    ctx.storage.mount('domain', facility)
    const changes = vi.fn()
    ctx.on('domain/changed', changes)
    const spec = defineDomain({ name: 'published', version: 1, layout,
      tables: { t: domainTable(z.object({ value: z.string() })) } })
    const domain = await facility.open(spec)
    const table = domain.table('t')
    await table.put('k', { value: 'old' })
    changes.mockClear()
    const path = layout === 'single' ? join(root, 'published.json') : join(root, 'published', 't', 'k.json')
    const restore = injectDirectoryFailure(path)
    const transform = vi.fn((value: { value: string }) => value)
    const failed = table.put('k', { value: 'new' })
    const queued = table.update('k', transform)
    const observed = Promise.allSettled([failed, queued])
    try {
      expect(await observed).toMatchObject([
        { status: 'rejected', reason: { name: 'StorageError', code: 'closed' } },
        { status: 'rejected', reason: { name: 'DomainError', code: 'closed' } },
      ])
    } finally {
      restore()
    }
    expect(transform).not.toHaveBeenCalled()
    expect(changes).not.toHaveBeenCalled()
    expect(() => table.get('k')).toThrow(/closed/)
    expect(() => table.entries()).toThrow(/closed/)
    expect(() => table.keys()).toThrow(/closed/)
    expect(() => table.size).toThrow(/closed/)
    await expect(table.put('later', { value: 'later' })).rejects.toMatchObject({ code: 'closed' })
    const reopened = await facility.open(spec)
    expect(reopened.table('t').get('k')).toEqual({ value: 'new' })
    await reopened.table('t').update('k', value => ({ value: `${value.value}-updated` }))
    expect(reopened.table('t').get('k')).toEqual({ value: 'new-updated' })
    await domain.close()
    expect(facility.get(spec.name)).toBe(reopened)
    await reopened.close()
  })
})
