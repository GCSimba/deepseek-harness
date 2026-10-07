/**
 * One opened JSON unit in `single` layout: the whole unit is one document at
 * `<root>/<name>.json`. The in-memory state is authoritative; every write
 * primitive mutates it and republishes the whole file atomically. Writes are
 * NOT queued here — per the backend contract, write ordering belongs to the
 * caller (the domain layer's write chain); this unit only guarantees that
 * each resolved call publishes a complete, durable file. A failure before
 * replacement restores memory; a directory-sync failure after replacement
 * retires the unit with `closed`, requiring a fresh open from the medium.
 * The `per-record` layout is a separate unit class in `per-record-unit.ts`.
 * @module @deepseek-ai/dsh-storage-json/src/single-unit
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { PublishedWriteDurabilityError, writeAtomic } from './atomic.ts'
import { JsonUnitLifetime } from './unit-lifetime.ts'
import { parse, serialize } from './format.ts'
import type { UnitState } from './format.ts'

/**
 * Open (load or lazily create) one `single`-layout unit under `root`: the
 * unit file is `<root>/<name>.json`.
 * @param descriptor - Static identity and shape of the unit.
 * @param root - Absolute backend root directory.
 * @param onClose - Backend callback releasing the unit's open-slot.
 * @returns the opened unit.
 */
export async function openSingleUnit(
  descriptor: KvUnitDescriptor,
  root: string,
  onClose: () => void,
): Promise<KvUnit> {
  const path = join(root, `${descriptor.name}.json`)
  let text: string | undefined
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Missing file = empty unit; materialization defers to the first write.
  }
  const state: UnitState =
    text === undefined
      ? {
        version: descriptor.version,
        global: null,
        tables: new Map(descriptor.tables.map(table => [table, new Map<string, unknown>()])),
      }
      : parse(text, descriptor)
  return new SingleJsonUnit(descriptor, path, state, onClose)
}

class SingleJsonUnit implements KvUnit {
  private readonly lifetime: JsonUnitLifetime

  constructor(
    private readonly descriptor: KvUnitDescriptor,
    private readonly path: string,
    private readonly state: UnitState,
    onClose: () => void,
  ) {
    this.lifetime = new JsonUnitLifetime(descriptor.name, onClose)
  }

  // oxlint-disable-next-line typescript/require-await -- async keeps the closed guard a rejection, not a synchronous throw
  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.lifetime.assertOpen()
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [table, records] of this.state.tables) {
      tables[table] = Object.fromEntries(records)
    }
    return { tables, global: this.state.global }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.lifetime.assertOpen()
    const records = this.records(table)
    const hadKey = records.has(key)
    const previous = records.get(key)
    records.set(key, value)
    await this.publish(() => {
      if (hadKey) records.set(key, previous)
      else records.delete(key)
    })
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.lifetime.assertOpen()
    const records = this.records(table)
    if (!records.has(key)) return
    const previous = records.get(key)
    records.delete(key)
    await this.publish(() => {
      records.set(key, previous)
    })
  }

  async setGlobal(value: unknown): Promise<void> {
    this.lifetime.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
    }
    const previous = this.state.global
    this.state.global = value
    await this.publish(() => {
      this.state.global = previous
    })
  }

  close(): Promise<void> {
    return this.lifetime.close()
  }

  private records(table: string): Map<string, unknown> {
    const records = this.state.tables.get(table)
    if (!records) {
      throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
    return records
  }

  private publish(rollback: () => void): Promise<void> {
    return this.lifetime.run(async () => {
      try {
        await writeAtomic(this.path, serialize(this.descriptor.name, this.state))
      } catch (error) {
        if (!(error instanceof PublishedWriteDurabilityError)) rollback()
        throw error
      }
    })
  }
}
