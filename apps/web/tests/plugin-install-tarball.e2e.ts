// Installation state is independent of a model turn; its expected ARIA stays app-local.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it('passes a signed tarball URL from the install dialog to the package manager intact', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-install-tarball-'))
  const overlay = join(scratch, 'cordis.patch.yml')
  let scaffold: WebScaffold | undefined
  try {
    await writeFile(overlay, `- id: plugin-manager\n  config: ${JSON.stringify({ pnpmCommand: process.execPath })}\n`)
    scaffold = await launchWebScaffold({
      profile: { packages: [] },
      extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), overlay],
    })
    const browser = await chromium.launch()
    try {
      const profile = join(scaffold.harnessHome, 'profiles', 'scaffold')
      const manifestPath = join(profile, 'package.json')
      const manifest = await readFile(manifestPath, 'utf8')
      const spec = 'https://cdn.example.test/plugin.tgz?token=probe&download=1'
      // The package-manager process is the external replacement; Host validation and RPC stay real.
      await writeFile(join(profile, 'config'), "console.log('https://registry.npmjs.org/')\n")
      await writeFile(join(profile, 'add'), `
        import('node:fs').then((fs) => {
          fs.writeFileSync('tarball-args.json', JSON.stringify(process.argv.slice(2)));
          fs.writeFileSync('tarball-pid.json', JSON.stringify(process.pid));
          console.log('Waiting for tarball download');
          setInterval(() => {}, 1000);
        });
      `)
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await page.waitForSelector('[class*="frame"]')
      if (await page.getByRole('dialog', { name: '设置' }).count() > 0) await page.keyboard.press('Escape')
      await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
      const panel = page.locator('[data-plugin-panel]')
      await panel.getByRole('button', { name: '添加插件', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('textbox', { name: '包名或地址', exact: true }).fill(spec)
      await dialog.getByRole('button', { name: '安装', exact: true }).click()
      await dialog.getByRole('button', { name: '查看安装详情', exact: true }).click()
      await dialog.getByText('Waiting for tarball download', { exact: true }).waitFor()
      const args: unknown = JSON.parse(await readFile(join(profile, 'tarball-args.json'), 'utf8'))
      expect(args).toEqual(expect.arrayContaining([spec]))
      const pid: unknown = JSON.parse(await readFile(join(profile, 'tarball-pid.json'), 'utf8'))
      if (typeof pid !== 'number') throw new Error('package-manager fixture did not record its PID')
      const aria = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd, {
        runningJobs: 'keep',
        replacements: [[profile, '{{profile}}']],
      })
      await compareOrRefreshGolden(
        fileURLToPath(new URL('./expected/plugin-install-tarball/downloading.expected.md', import.meta.url)),
        aria, webSnapshotMode(),
      )
      await dialog.getByRole('button', { name: '取消安装', exact: true }).click()
      await dialog.getByRole('textbox').waitFor()
      await expect.poll(() => {
        try {
          process.kill(pid, 0)
          return true
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
          throw error
        }
      }).toBe(false)
      expect(await dialog.getByRole('textbox').inputValue()).toBe(spec)
      expect(await readFile(manifestPath, 'utf8')).toBe(manifest)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold?.close()
    await rm(scratch, { recursive: true, force: true })
  }
})
