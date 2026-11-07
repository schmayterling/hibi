import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForFormattedEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

test('renderer delivery waits for the matching key and removes its listener', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-keyboard-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForFormattedEditor(app, page)
  await page.evaluate(() => {
    window.deliveredKeys = []
    const target = document.createElement('button')
    target.textContent = 'Delivery target'
    target.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() === 'x') window.deliveredKeys.push('x')
      event.preventDefault()
      event.stopPropagation()
    })
    // Renderer controls can consume both events; delivery cannot await keyup.
    target.addEventListener('keyup', (event) => event.stopPropagation())
    document.body.append(target)
    target.focus()
    const add = window.addEventListener.bind(window)
    const remove = window.removeEventListener.bind(window)
    window.deliveryListeners = new Set()
    window.addEventListener = (type, listener, options) => {
      if (type === 'keydown') {
        window.deliveryListeners.add(listener)
        // An unrelated key must not acknowledge the requested one.
        queueMicrotask(() =>
          window.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowLeft' }),
          ),
        )
      }
      add(type, listener, options)
    }
    window.removeEventListener = (type, listener, options) => {
      if (type === 'keydown') window.deliveryListeners.delete(listener)
      remove(type, listener, options)
    }
  })
  await pressShortcut(app, 'X', { delivered: true })
  assert.deepEqual(await page.evaluate(() => window.deliveredKeys), ['x'])
  assert.equal(await page.evaluate(() => window.deliveryListeners.size), 0)

  // Main consumes app shortcuts; their default dispatch must still return.
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${mod}+k`)
  await page.getByRole('dialog', { name: /^command palette$/i }).waitFor()
  assert.equal(await page.evaluate(() => window.deliveryListeners.size), 0)
})
