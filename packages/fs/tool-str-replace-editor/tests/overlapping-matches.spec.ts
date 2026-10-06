import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolStrReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'

it.each(['LF', 'CRLF'] as const)('rejects overlapping whole-line %s matches without changing the file through either editor', async (lineEndings) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-audit-overlap-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(ToolStrReplaceEditor)
    const path = join(root, 'repeated.txt')
    const before = lineEndings === 'LF' ? 'item\nitem\nitem\n' : 'item\r\nitem\r\nitem\r\n'
    const old = lineEndings === 'LF' ? 'item\nitem\n' : 'item\r\nitem\r\n'
    const ordinaryDuplicates = `${old}between\n${old}`
    await writeFile(path, ordinaryDuplicates)
    const control = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('audit-overlap-control'),
      name: 'str_replace_editor',
      arguments: { command: 'str_replace', path, old_str: old, new_str: 'changed\n' },
    })
    expect(control.isError).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(ordinaryDuplicates)
    await writeFile(path, before)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('audit-overlap'),
      name: 'str_replace_editor',
      arguments: { command: 'str_replace', path, old_str: old, new_str: 'changed\n' },
    })
    const after = await readFile(path, 'utf8')
    await writeFile(path, before)
    await expect(ctx.fs.editText(
      await ctx.fs.resolve(path),
      { oldString: old, newString: 'changed\n', replaceAll: false },
    )).rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
    const fsLocalAfter = await readFile(path, 'utf8')
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { code: 'FS_AMBIGUOUS_EDIT' } })
    expect(after).toBe(before)
    expect(fsLocalAfter).toBe(before)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
