import { Context, type Fiber } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SESSION_QUERY_SQLITE_SCHEMA_VERSION } from '../src/schema.ts'
import { expect, it } from 'vitest'

const events: SessionEvent[] = [{
  type: 'user/message', seq: SessionSeq(0), time: 1,
  data: createUserMessage({ content: [{ type: 'text', text: 'needle' }], source: { kind: 'user' } }),
  surfaceOp: 'append',
}]

for (const mode of ['live', 'persisted'] as const) {
  it.each([
    { kind: 'subagent', meta: { parentSession: SessionId('parent'), origin: 'subagent', delegationDepth: 1 } },
    { kind: 'fork', meta: { parentSession: SessionId('parent') } },
    { kind: 'root', meta: {} },
  ] satisfies { kind: string; meta: Partial<SessionHeader> }[])(`preserves $kind metadata in ${mode} search headers`, async ({ meta }) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-audit-sdk-origin-'))
    const fibers: Fiber[] = []
    try {
      const ctx = new Context()
      fibers.push(await ctx.plugin(SessionStore))
      fibers.push(await ctx.plugin(SessionProjectionRegistry))
      const id = SessionId('audit-child')
      const header: SessionHeader = {
        version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false,
        cwd: root, agentPreset: 'code', delegationDepth: 0, ...meta,
      }
      if (mode === 'live') {
        ctx.sessions.create(id, { seed: events, meta: header })
      } else {
        fibers.push(await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' }))
        const writer = await ctx.sessionPersistence.create(header)
        try {
          await writer.append(events)
          await writer.flush()
        } finally {
          await writer.close()
        }
      }
      fibers.push(await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:' }))
      const listed = (await ctx.sessionQuery.listSessions())[0]?.header
      const searched = (await ctx.sessionQuery.searchSessions({ query: 'needle' })).items[0]?.header
      const searchedEvents = (await ctx.sessionQuery.searchEvents({ sessionId: id, query: 'needle' })).session
      expect(listed).toEqual(header)
      expect(searched).toEqual(listed)
      expect(searchedEvents).toEqual(listed)
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}

it('rebuilds a version-eight index from unchanged JSONL and retains origin across reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-search-header-rebuild-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION, id: SessionId('child'), createdAt: 1, isSeeded: false,
      origin: 'subagent', parentSession: SessionId('parent'), delegationDepth: 1,
    }
    const writer = await ctx.sessionPersistence.create(header)
    await writer.append(events)
    await writer.close()
    const filename = (await readdir(join(root, 'sessions'), { recursive: true })).find(name => name.endsWith('.jsonl'))
    if (filename === undefined) throw new Error('expected JSONL medium')
    const log = join(root, 'sessions', filename)
    const canonical = await readFile(log, 'utf8')
    const path = join(root, 'derived.db')
    const search = await ctx.plugin(SqliteSessionQueryEngine, { path })
    expect((await ctx.sessionQuery.searchSessions({ query: 'needle' })).items[0]?.header).toEqual(header)
    await search.dispose()

    const stale = new DatabaseSync(path)
    try {
      stale.exec('ALTER TABLE persisted_sessions DROP COLUMN origin; PRAGMA user_version = 8')
    } finally {
      stale.close()
    }
    const rebuilt = await ctx.plugin(SqliteSessionQueryEngine, { path })
    expect((await ctx.sessionQuery.searchEvents({ sessionId: header.id, query: 'needle' })).session).toEqual(header)
    await rebuilt.dispose()
    await ctx.plugin(SqliteSessionQueryEngine, { path })
    expect((await ctx.sessionQuery.searchSessions({ query: 'needle' })).items[0]?.header).toEqual(header)
    expect(await readFile(log, 'utf8')).toBe(canonical)
    const current = new DatabaseSync(path)
    try {
      expect(current.prepare('PRAGMA user_version').get()).toEqual({ user_version: SESSION_QUERY_SQLITE_SCHEMA_VERSION })
    } finally {
      current.close()
    }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
