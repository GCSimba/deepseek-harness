/** Real-file publication failures and reopening through both JSON layouts. */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { fixture, injectDirectoryFailure } from './helpers/publication-fault.ts'

describe.each(['single', 'per-record'] as const)('%s published-write failure', (layout) => {
  const descriptor: KvUnitDescriptor = { name: 'published', version: 1, layout, tables: ['t'], hasGlobal: true }
  const pathOf = (root: string): string => layout === 'single'
    ? join(root, 'published.json') : join(root, 'published', 't', 'k.json')

  it('retires the unit after publication and preserves the new record across reopen and a later write', async () => {
    const { root, backend } = await fixture()
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'k', { value: 'old' })
    const path = pathOf(root)
    const restore = injectDirectoryFailure(path, true)
    let failure: unknown
    try {
      failure = await unit.putRecord('t', 'k', { value: 'new' }).catch((error: unknown) => error)
    } finally {
      restore()
    }
    expect(failure).toMatchObject({
      name: 'StorageError', code: 'closed',
      cause: { name: 'PublishedWriteDurabilityError', cause: { message: 'injected directory sync failure' } },
    })
    const published: unknown = JSON.parse(await readFile(path, 'utf8'))
    expect(published).toMatchObject(layout === 'single'
      ? { tables: { t: { k: { value: 'new' } } } } : { version: 1, record: { value: 'new' } })
    await expect(unit.loadAll()).rejects.toMatchObject({ code: 'closed' })
    await expect(unit.putRecord('t', 'later', { value: true })).rejects.toMatchObject({ code: 'closed' })
    await expect(unit.deleteRecord('t', 'k')).rejects.toMatchObject({ code: 'closed' })
    await expect(unit.setGlobal({ value: true })).rejects.toMatchObject({ code: 'closed' })
    if (unit.backupRecord) await expect(unit.backupRecord('t', 'k')).rejects.toMatchObject({ code: 'closed' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(published)
    const reopened = await backend.kv.open(descriptor)
    expect((await reopened.loadAll()).tables.t).toEqual({ k: { value: 'new' } })
    await reopened.putRecord('t', 'later', { value: true })
    expect((await reopened.loadAll()).tables.t).toEqual({ k: { value: 'new' }, later: { value: true } })
    await Promise.all([unit.close(), unit.close()])
    await expect(backend.kv.open(descriptor)).rejects.toThrow(/already open/)
  })

  it('reloads the published global rather than the cached global after a failed acknowledgment', async () => {
    const { root, backend } = await fixture()
    const unit = await backend.kv.open(descriptor)
    await unit.setGlobal({ value: 'old' })
    const path = layout === 'single' ? join(root, 'published.json') : join(root, 'published', 'global.json')
    const restore = injectDirectoryFailure(path)
    try {
      await expect(unit.setGlobal({ value: 'new' })).rejects.toMatchObject({ code: 'closed' })
    } finally {
      restore()
    }
    const reopened = await backend.kv.open(descriptor)
    expect((await reopened.loadAll()).global).toEqual({ value: 'new' })
    await reopened.putRecord('t', 'later', { value: true })
    expect((await reopened.loadAll()).global).toEqual({ value: 'new' })
  })
})

it('does not resurrect a deleted single-layout record after publication fails durability', async () => {
  const { root, backend } = await fixture()
  const descriptor: KvUnitDescriptor = { name: 'published', version: 1, tables: ['t'], hasGlobal: false }
  const unit = await backend.kv.open(descriptor)
  await unit.putRecord('t', 'k', { value: 'old' })
  const restore = injectDirectoryFailure(join(root, 'published.json'))
  try {
    await expect(unit.deleteRecord('t', 'k')).rejects.toMatchObject({ code: 'closed' })
  } finally {
    restore()
  }
  const reopened = await backend.kv.open(descriptor)
  expect((await reopened.loadAll()).tables.t).toEqual({})
  await reopened.putRecord('t', 'later', { value: true })
  expect((await reopened.loadAll()).tables.t).toEqual({ later: { value: true } })
})

it('keeps a per-record unit usable when replacement fails before publication', async () => {
  const { root, backend } = await fixture()
  const descriptor: KvUnitDescriptor = { name: 'published', version: 1, layout: 'per-record', tables: ['t'], hasGlobal: false }
  const unit = await backend.kv.open(descriptor)
  await unit.putRecord('t', 'k', { value: 'old' })
  const blocked = join(root, 'published', 't', 'later.json')
  await mkdir(blocked)
  await expect(unit.putRecord('t', 'later', { value: 'rejected' })).rejects.toThrow()
  expect((await unit.loadAll()).tables.t).toEqual({ k: { value: 'old' } })
  await rm(blocked, { recursive: true })
  await unit.putRecord('t', 'later', { value: 'accepted' })
  expect((await unit.loadAll()).tables.t).toEqual({ k: { value: 'old' }, later: { value: 'accepted' } })
})

it('retires a per-record unit when legacy bootstrap publishes before failing directory sync', async () => {
  const { root, backend } = await fixture()
  const descriptor: KvUnitDescriptor = { name: 'published', version: 1, layout: 'per-record', tables: ['t'], hasGlobal: false }
  const legacyPath = join(root, 'published.json')
  const legacy = JSON.stringify({ unit: { name: 'published', version: 1 }, global: null, tables: { t: { k: { value: 'legacy' } } } })
  await writeFile(legacyPath, legacy)
  const unit = await backend.kv.open(descriptor)
  const restore = injectDirectoryFailure(join(root, 'published', 't', 'k.json'))
  try {
    await expect(unit.loadAll()).rejects.toMatchObject({ code: 'closed' })
  } finally {
    restore()
  }
  await expect(unit.loadAll()).rejects.toMatchObject({ code: 'closed' })
  expect(await readFile(legacyPath, 'utf8')).toBe(legacy)
  const reopened = await backend.kv.open(descriptor)
  expect((await reopened.loadAll()).tables.t).toEqual({ k: { value: 'legacy' } })
})
