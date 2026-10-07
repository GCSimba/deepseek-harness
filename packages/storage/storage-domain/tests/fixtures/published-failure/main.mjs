/** Loader application with real JSON publication and one injected directory-sync failure. */
import fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { boot } from '../../../../../boot/app-boot/src/index.ts'
import { defineDomain, domainTable } from '../../../src/index.ts'

const [root, layout] = process.argv.slice(2)
if (!root || !['single', 'per-record'].includes(layout)) throw new Error('root and JSON layout required')
const originalOpen = fs.promises.open
let failingDirectory
fs.promises.open = async (...args) => {
  const handle = await originalOpen(...args)
  if (args[0] === failingDirectory && args[1] === 'r') {
    handle.sync = async () => { throw new Error('injected application directory sync failure') }
  }
  return handle
}
syncBuiltinESMExports()

let ctx
let result
try {
  ctx = await boot('published-write-test', fileURLToPath(new URL('./cordis.yml', import.meta.url)))
  const spec = defineDomain({ name: 'published', version: 1, layout,
    tables: { t: domainTable(z.object({ value: z.string() })) } })
  const domain = await ctx.storageDomain.open(spec)
  await domain.table('t').put('k', { value: 'old' })
  const path = layout === 'single' ? join(root, 'published.json') : join(root, 'published', 't', 'k.json')
  failingDirectory = dirname(path)
  let failure
  try {
    await domain.table('t').put('k', { value: 'new' })
  } catch (error) {
    failure = error.code
  } finally {
    failingDirectory = undefined
  }
  let staleRead
  try {
    domain.table('t').get('k')
  } catch (error) {
    staleRead = error.code
  }
  const published = JSON.parse(await readFile(path, 'utf8'))
  const disk = layout === 'single' ? published.tables.t.k : published.record
  const reopened = await ctx.storageDomain.open(spec)
  const fromReopen = reopened.table('t').get('k')
  await reopened.table('t').put('later', { value: 'other' })
  result = { failure, staleRead, disk, fromReopen, afterLater: Object.fromEntries(reopened.table('t').entries()) }
} finally {
  await ctx?.fiber.dispose()
  fs.promises.open = originalOpen
  syncBuiltinESMExports()
}
console.log(JSON.stringify(result))
