/** XDG directory defaults and desktop-entry metadata escaping. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { nativeFileApplications } from '../src/file-applications.ts'
import { desktopDataDirectories, desktopEntryFields } from '../src/desktop-entry.ts'
import type { NativeCommandRunner } from '../src/runner.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-escaping-audit-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'applications'))
  await mkdir(join(root, 'pixmaps'))
  const source = join(root, 'applications', 'fixture.desktop')
  const artwork = join(root, 'pixmaps', 'fixture viewer.svg')
  await writeFile(artwork, '<svg xmlns="http://www.w3.org/2000/svg"><title>fixture</title></svg>')
  const run = vi.fn<NativeCommandRunner>(async command => ({
    stdout: command === 'gio' ? 'standard::content-type: text/plain\n'
      : 'Default application for text/plain: fixture.desktop\nRegistered applications:\n  fixture.desktop\n',
    stderr: '',
  }))
  const facts = {
    platform: 'linux' as const,
    osRelease: 'Linux',
    env: { HOME: root, XDG_DATA_HOME: root, XDG_DATA_DIRS: join(root, 'absent-system-data'), LANG: 'en_US.UTF-8' },
    run,
  }
  return { source, artwork, facts }
}

it('decodes a desktop-entry localized display name', async () => {
  const { source, facts } = await fixture()
  await writeFile(source, '[Desktop Entry]\nType=Application\nName=Fixture\\sViewer\nName[en_US]=Localized\\sViewer\nExec=viewer %f\n')
  const apps = await nativeFileApplications('/fixture.txt', new AbortController().signal, facts)
  await writeFile(source, '[Desktop Entry]\nType=Application\nName=Fixture Viewer\nName[en_US]=Localized Viewer\nExec=viewer %f\n')
  const control = await nativeFileApplications('/fixture.txt', new AbortController().signal, facts)
  expect(control[0]?.name).toBe('Localized Viewer')
  expect(apps[0]?.name).toBe('Localized Viewer')
})

it('resolves an installed icon whose desktop-entry name escapes a space', async () => {
  const { source, artwork, facts } = await fixture()
  await writeFile(source, '[Desktop Entry]\nType=Application\nName=Fixture Viewer\nIcon=fixture\\sviewer\nExec=viewer %f\n')
  const bytes = await readFile(artwork)
  const apps = await nativeFileApplications('/fixture.txt', new AbortController().signal, facts)
  const expected = `data:image/svg+xml;base64,${bytes.toString('base64')}`
  await writeFile(source, '[Desktop Entry]\nType=Application\nName=Fixture Viewer\nIcon=fixture viewer\nExec=viewer %f\n')
  const control = await nativeFileApplications('/fixture.txt', new AbortController().signal, facts)
  expect(control[0]?.icon).toBe(expected)
  expect(apps[0]?.icon).toBe(expected)
})

it('decodes metadata string escapes once without decoding executable commands or action fields', () => {
  expect(desktopEntryFields(String.raw`# metadata
[Desktop Entry]
Name=\sViewer\s\n\t\r\\s
Name[zh_CN]=\s查看器\s
Icon=viewer\\sicon
Exec=viewer "\\s" %f
TryExec=/usr/bin/viewer\scli
Unknown=\s
malformed
[Desktop Action extra]
Name=Action
Icon=action
`)).toEqual({
    Name: ' Viewer \n\t\r\\s',
    'Name[zh_CN]': ' 查看器 ',
    Icon: 'viewer\\sicon',
    Exec: String.raw`viewer "\\s" %f`,
    TryExec: String.raw`/usr/bin/viewer\scli`,
    Unknown: String.raw`\s`,
  })
})

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
