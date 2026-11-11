import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  stopElectronTree,
  waitForFormattedEditor,
} from './electron.mjs'

// Kill immediately after the setting handler returns, without a clean quit or
// Chromium's delayed DOMStorage flush. A checked setting must already last.
test('turning autosave off survives an immediate app-tree crash', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-preference-crash-'))
  let running
  t.after(async () => {
    await running?.close()
    await rm(profile, { recursive: true, force: true })
  })
  const launch = async () => {
    running = await electron.launch({
      autosave: true,
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    const page = await running.firstWindow()
    await waitForFormattedEditor(running, page)
    return page
  }
  const page = await launch()
  await page.locator('[data-status-id="autosave"]').click()
  const child = running.process()
  const gone = once(child, 'exit')
  await running.evaluate(({ ipcMain }) => {
    ipcMain._invokeHandlers.set('app:info', () =>
      process.kill(process.pid, 'SIGKILL'),
    )
  })
  // The next IPC after the actual setting handler kills main, within the same
  // renderer task; no Playwright round trip can give Chromium time to flush.
  await page
    .getByRole('checkbox', { name: /^autosave$/i })
    .evaluate((input) => {
      if (!input.checked) throw new Error('fresh profile must default on')
      input.click()
      void window.hibi.getAppInfo().catch(() => {})
    })
    .catch(() => {})
  running = null
  await gone
  stopElectronTree(child)
  const reopened = await launch()
  assert.equal(
    await reopened.locator('[data-status-id="autosave"]').innerText(),
    'Autosave off',
  )
})

for (const [name, set, get, value] of [
  ['kept undo history', 'setKeepUndoHistory', 'getKeepUndoHistory', false],
  [
    'recovery policy',
    'setRecoverySettings',
    'getRecoverySettings',
    { keep: false, days: 30, megabytes: 512, openAtLaunch: false },
  ],
  [
    'addon trust consent',
    'setAddonTrustSettings',
    'getAddonTrustSettings',
    { allowUnsigned: false, checkRevocations: false },
  ],
]) {
  test(`${name} survives a crash after its setter returns`, {
    timeout: 60000,
  }, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-safety-setting-'))
    let running
    t.after(async () => {
      await running?.close()
      await rm(profile, { recursive: true, force: true })
    })
    const launch = async () => {
      running = await electron.launch({
        autosave: true,
        args: [resolve('.'), `--user-data-dir=${profile}`],
      })
      const page = await running.firstWindow()
      await waitForFormattedEditor(running, page)
      return page
    }
    const page = await launch()
    const child = running.process()
    const gone = once(child, 'exit')
    await running.evaluate(({ ipcMain }) => {
      ipcMain._invokeHandlers.set('app:info', () =>
        process.kill(process.pid, 'SIGKILL'),
      )
    })
    await page
      .evaluate(
        async ({ set, value }) => {
          await window.hibi[set](value)
          void window.hibi.getAppInfo().catch(() => {})
        },
        { set, value },
      )
      .catch(() => {})
    running = null
    await gone
    stopElectronTree(child)
    const reopened = await launch()
    assert.deepEqual(
      await reopened.evaluate((get) => window.hibi[get](), get),
      value,
    )
  })
}
