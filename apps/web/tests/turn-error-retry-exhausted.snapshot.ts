// @vitest-environment jsdom
// Assembled retry-exhaustion snapshot: boots the built Web application against
// FixtureApiClient, drives a correlated retry chain to its terminal turn/end,
// and pins the persistent failure row beside the retained retry disclosure.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { hasClass, installAssembledBootEnv, mountAssembledApp, REFRESHING_GOLDEN } from './assembled-boot.ts'

const EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/turn-error-retry-exhausted/history-turn.expected.txt')

interface RetryTimingHooks {
  beginModelRetry(id: string): void
  scheduleModelRetry(id: string, retry?: number, delayMs?: number): void
  exhaustModelRetry(id: string): void
}

installAssembledBootEnv()

/** Normalize the terminal row to its stable dot, copy, and error code. */
function errorShape(row: Element): string {
  const first = (name: string): string =>
    [...row.querySelectorAll('*')].find(element => hasClass(element, name))?.textContent?.trim() ?? '<absent>'
  return [
    `dot=${row.querySelector('[data-state]')?.getAttribute('data-state') ?? '<absent>'}`,
    `title=${first('turnErrorTitle')}`,
    `message=${first('turnErrorMessage')}`,
    `code=${first('turnErrorCode')}`,
  ].join('\n')
}

describe('assembled retry-exhausted turn failure', () => {
  it('keeps the retry disclosure and renders the terminal error', async () => {
    mountAssembledApp()

    const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
    fireEvent.click(await within(tree).findByText('Fixture 历史会话'))
    await screen.findByText(/条目 3：这一条写到一半被/, undefined, { timeout: 10_000 })

    const hooks = (globalThis as Record<string, unknown>).__fxTiming as RetryTimingHooks
    await act(async () => {
      hooks.beginModelRetry('fx-alpha')
      hooks.scheduleModelRetry('fx-alpha', 1, 10)
      hooks.scheduleModelRetry('fx-alpha', 2, 10)
      hooks.exhaustModelRetry('fx-alpha')
    })

    await screen.findByText(/Model request retry cancelled \(2\/2\)/, undefined, { timeout: 10_000 })
    const row = await waitFor(() => {
      const found = [...document.querySelectorAll('[role="status"]')]
        .find(candidate => [...candidate.querySelectorAll('*')].some(element => hasClass(element, 'turnErrorTitle')))
      expect(found).not.toBeUndefined()
      return found!
    }, { timeout: 10_000 })

    const shape = errorShape(row)
    if (REFRESHING_GOLDEN) {
      mkdirSync(dirname(EXPECTED), { recursive: true })
      writeFileSync(EXPECTED, shape)
    }
    await expect(shape).toMatchFileSnapshot(EXPECTED)
  })
})
