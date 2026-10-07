/** Keyless Loader/process evidence for terminal JSON publication failures on POSIX. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it, onTestFinished } from 'vitest'

const run = promisify(execFile)

describe.skipIf(process.platform === 'win32')('POSIX JSON Loader application', () => {
  it.each(['single', 'per-record'])('reopens %s state without overwriting its published value', { retry: 0 }, async (layout) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-publication-app-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const { stdout } = await run(process.execPath, ['--import', 'tsx/esm',
      fileURLToPath(new URL('./fixtures/published-failure/main.mjs', import.meta.url)), root, layout], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      env: { ...process.env, DSH_PUBLICATION_TEST_ROOT: root },
      timeout: 60_000,
    })
    const observed: unknown = JSON.parse(stdout.trim().split('\n').at(-1)!)
    expect(observed).toEqual({
      failure: 'closed', staleRead: 'closed',
      disk: { value: 'new' }, fromReopen: { value: 'new' },
      afterLater: { k: { value: 'new' }, later: { value: 'other' } },
    })
  })
})
