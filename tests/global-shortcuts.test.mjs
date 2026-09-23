import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'

test('global shortcut registration rejects conflicts and releases keys', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-global-shortcut-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.locator('.titlebar').waitFor()
  const shortcut = 'Control+Alt+Shift+F9'
  await assert.rejects(
    page.evaluate(() => window.hibi.registerGlobalShortcut('bad', 'A')),
    /modifier and key/,
  )
  await assert.rejects(
    page.evaluate(() =>
      window.hibi.registerGlobalShortcut('test.shift', 'Shift+A'),
    ),
    /modifier and key/,
  )
  await page.evaluate(
    (value) => window.hibi.registerGlobalShortcut('test.one', value),
    shortcut,
  )
  assert.equal(
    await app.evaluate(
      ({ globalShortcut }, value) => globalShortcut.isRegistered(value),
      shortcut,
    ),
    true,
  )
  await assert.rejects(
    page.evaluate(
      (value) => window.hibi.registerGlobalShortcut('test.two', value),
      shortcut,
    ),
    /already in use/,
  )
  await page.evaluate(() => window.hibi.unregisterGlobalShortcut('test.one'))
  assert.equal(
    await app.evaluate(
      ({ globalShortcut }, value) => globalShortcut.isRegistered(value),
      shortcut,
    ),
    false,
  )
})
