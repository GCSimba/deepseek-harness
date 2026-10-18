import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OutputCollector, prepareManagedProcessBinding } from '../src/output.ts'

const collectors: OutputCollector[] = []
const directories: string[] = []
const originalWrite = fs.writeSync
const originalOpen = fs.openSync

afterEach(() => {
  for (const collector of collectors.splice(0)) collector.seal()
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  expect(fs.writeSync).toBe(originalWrite)
  expect(fs.openSync).toBe(originalOpen)
})

/** Injects short writes only on the collector's descriptor, leaving all file operations real. */
function fixture(shortAt: number | 'every', failAfterShort = false) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'dsh-output-short-write-'))
  directories.push(dir)
  const onFailure = vi.fn()
  const collector = new OutputCollector(4, 'short-write', { dir, maxBytes: 100, onFailure })
  collectors.push(collector)
  const failure = Object.assign(new Error('simulated ENOSPC after partial progress'), { code: 'ENOSPC' })
  let descriptor: number | undefined
  let calls = 0
  let shortWrites = 0
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    const fd = originalOpen(path, flags, mode)
    if (typeof path === 'string' && dirname(path) === dir) descriptor = fd
    return fd
  })
  vi.spyOn(fs, 'writeSync').mockImplementation((
    fd: number,
    data: string | NodeJS.ArrayBufferView,
    offset?: number | null,
    length?: number | BufferEncoding | null,
    position?: number | null,
  ): number => {
    if (typeof data === 'string') return originalWrite(fd, data, offset, typeof length === 'string' ? length : undefined)
    const start = offset ?? 0
    const count = typeof length === 'number' ? length : data.byteLength - start
    if (fd !== descriptor) return originalWrite(fd, data, start, count, position)
    calls += 1
    if (failAfterShort && shortWrites > 0) throw failure
    if ((shortAt === 'every' || calls === shortAt) && count > 1) {
      shortWrites += 1
      return originalWrite(fd, data, start, 1, position)
    }
    return originalWrite(fd, data, start, count, position)
  })
  // Update named ESM imports as well as the fs object used inside writeFileSync.
  syncBuiltinESMExports()
  return { collector, dir, onFailure, failure, shortWrites: () => shortWrites }
}

describe('OutputCollector spill writes', () => {
  it('retains complete output in the shared default spill directory', () => {
    const binding = prepareManagedProcessBinding()
    directories.push(binding.spillDir)
    expect(prepareManagedProcessBinding().spillDir).toBe(binding.spillDir)
    const collector = new OutputCollector(4, 'default', {
      dir: binding.spillDir, maxBytes: 100, onFailure: binding.onSpillFailure,
    })
    collectors.push(collector)
    collector.push(Buffer.from('AAAABBBB'))
    expect(fs.readFileSync(collector.finalize().spillPath!, 'utf8')).toBe('AAAABBBB')
  })

  it('preserves ordinary writes without fault injection', () => {
    const { collector, onFailure, shortWrites } = fixture(0)
    for (const chunk of ['AAAA', 'BBBB', 'CCCC']) collector.push(Buffer.from(chunk))
    const result = collector.finalize()
    expect(fs.readFileSync(result.spillPath!, 'utf8')).toBe('AAAABBBBCCCC')
    expect(shortWrites()).toBe(0)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('preserves UTF-8 bytes across repeated short writes', () => {
    const { collector, onFailure, shortWrites } = fixture('every')
    const bytes = Buffer.from('汉字🙂完整输出')
    collector.push(bytes.subarray(0, 4))
    collector.push(bytes.subarray(4, 9))
    collector.push(bytes.subarray(9))
    expect(fs.readFileSync(collector.finalize().spillPath!)).toEqual(bytes)
    expect(shortWrites()).toBeGreaterThan(1)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it.each([
    ['buffered replay', 1],
    ['overflowing chunk', 2],
    ['later append', 3],
    ['repeated partial writes', 'every'],
  ] as const)('preserves every byte after %s', (_label, shortAt) => {
    const { collector, onFailure, shortWrites } = fixture(shortAt)
    for (const chunk of ['AAAA', 'BBBB', 'CCCC']) collector.push(Buffer.from(chunk))
    const delta = collector.readFrom(0)
    expect(delta).toMatchObject({ text: 'CCCC', nextOffset: 12, lossy: true })
    expect(delta.spillPath).toBeDefined()
    expect(fs.readFileSync(delta.spillPath!, 'utf8')).toBe('AAAABBBBCCCC')
    const result = collector.finalize()
    expect(result).toEqual({ text: 'CCCC', truncated: true, spillPath: delta.spillPath })
    expect(fs.readFileSync(result.spillPath!, 'utf8')).toBe('AAAABBBBCCCC')
    const snapshot = collector.snapshot()
    expect(snapshot).toEqual({ bytes: Buffer.from('CCCC'), totalBytes: 12 })
    snapshot.bytes.fill(0)
    expect(collector.snapshot().bytes).toEqual(Buffer.from('CCCC'))
    expect(shortWrites()).toBeGreaterThan(0)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it.each([1, 2, 3])('withdraws the spill when short write %i is followed by ENOSPC', (shortAt) => {
    const { collector, dir, onFailure, failure, shortWrites } = fixture(shortAt, true)
    for (const chunk of ['AAAA', 'BBBB', 'CCCC']) {
      expect(() => { collector.push(Buffer.from(chunk)) }).not.toThrow()
    }
    expect(shortWrites()).toBe(1)
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure, 'short-write')
    expect(fs.readdirSync(dir)).toEqual([])
    expect(collector.readFrom(0)).toEqual({ text: 'CCCC', nextOffset: 12, lossy: true })
    collector.push(Buffer.from('DDDD'))
    expect(collector.finalize()).toEqual({ text: 'DDDD', truncated: true })
    expect(collector.finalize()).toEqual({ text: 'DDDD', truncated: true })
    expect(onFailure).toHaveBeenCalledTimes(1)
  })
})
