/** XDG directory precedence and defaults for inherited desktop environment values. */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { desktopDataDirectories } from '../src/desktop-entry.ts'

describe('desktopDataDirectories', () => {
  const home = join('/fixture', 'home')
  const defaultHome = join(home, '.local', 'share')

  describe.each([
    ['unset', undefined, defaultHome],
    ['empty', '', defaultHome],
    ['configured', '/custom/data', '/custom/data'],
  ] as const)('%s data home', (_label, dataHome, expectedHome) => {
    it.each([
      ['unset', undefined, ['/usr/local/share', '/usr/share']],
      ['empty', '', ['/usr/local/share', '/usr/share']],
      ['configured', '/first::/second', ['/first', '/second']],
    ] as const)('resolves %s system directories after the data home', (_label, dataDirs, expectedDirs) => {
      expect(desktopDataDirectories(home, { XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: dataDirs }))
        .toEqual([expectedHome, ...expectedDirs])
    })
  })
})
