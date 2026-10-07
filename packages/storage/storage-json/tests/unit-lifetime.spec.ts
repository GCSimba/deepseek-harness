/** Deterministic retirement and explicit-close races for the shared JSON lifecycle. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { PublishedWriteDurabilityError } from '../src/atomic.ts'
import { JsonUnitLifetime } from '../src/unit-lifetime.ts'

it('drains concurrent uncertain publications before releasing the unit once', async () => {
  const released = vi.fn()
  const lifetime = new JsonUnitLifetime('race', released)
  const first = Promise.withResolvers<undefined>()
  const second = Promise.withResolvers<undefined>()
  onTestFinished(async () => {
    first.resolve(undefined)
    second.resolve(undefined)
    await lifetime.close()
  })
  const observed = Promise.allSettled([
    lifetime.run(() => first.promise),
    lifetime.run(() => second.promise),
  ])
  first.reject(new PublishedWriteDurabilityError('/first', new Error('first sync failure')))
  await vi.waitFor(() => { expect(() => { lifetime.assertOpen() }).toThrow(/closed/) })
  const closing = lifetime.close()
  expect(released).not.toHaveBeenCalled()
  await expect(lifetime.run(async () => {})).rejects.toMatchObject({ code: 'closed' })
  second.reject(new PublishedWriteDurabilityError('/second', new Error('second sync failure')))
  expect(await observed).toMatchObject([
    { status: 'rejected', reason: { code: 'closed', cause: { cause: { message: 'first sync failure' } } } },
    { status: 'rejected', reason: { code: 'closed', cause: { cause: { message: 'second sync failure' } } } },
  ])
  await Promise.all([closing, lifetime.close()])
  expect(released).toHaveBeenCalledOnce()
})
