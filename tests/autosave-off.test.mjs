import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { replaceRichText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

// Test apps start with autosave off unless a test asks for it
// (tests/fixtures/autosave-off.cjs); a profile's own setting always wins.
async function profile(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-autosave-off-'))
  const data = join(root, 'profile')
  const file = join(root, 'note.md')
  await writeFile(file, 'original')
  const running = new Set()
  t.after(async () => {
    for (const app of running) await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const setting = () =>
    readFile(join(data, 'autosave.json'), 'utf8').then(JSON.parse, (error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  async function launch(options = {}) {
    const app = await electron.launch({
      ...options,
      args: [resolve('.'), `--user-data-dir=${data}`, file],
    })
    running.add(app)
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    const page = await app.firstWindow()
    await waitForDocumentEditor(app, page)
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).name === 'note.md',
    )
    return {
      page,
      rich: page.getByRole('textbox', { name: /document editor/i }),
      pill: page.locator('[data-status-id="autosave"]'),
      preferences: () =>
        page.evaluate(() => window.hibi.getAutosavePreferences(null)),
      async close() {
        await app.close()
        running.delete(app)
      },
    }
  }
  return { file, setting, launch }
}

test('a test app starts a new profile with autosave off', {
  timeout: 60000,
}, async (t) => {
  const { setting, launch } = await profile(t)
  const app = await launch()
  assert.deepEqual(await setting(), { enabled: false, delay: 2000 })
  assert.deepEqual(await app.preferences(), { enabled: false, delay: 2000 })
  await app.pill.getByText('Autosave off').waitFor()
})

test('autosave a profile turned on stays on in the next test app', {
  timeout: 90000,
}, async (t) => {
  const { file, setting, launch } = await profile(t)
  let app = await launch()
  await app.page.evaluate(() =>
    window.hibi.setAutosavePreferences({ enabled: true, delay: 1000 }),
  )
  await app.close()
  app = await launch()
  assert.deepEqual(await setting(), { enabled: true, delay: 1000 })
  assert.deepEqual(await app.preferences(), { enabled: true, delay: 1000 })
  await replaceRichText(app.page, app.rich, 'kept on')
  await waitForAsync(
    app.page,
    async () => !(await window.hibi.getDocument()).dirty,
  )
  assert.equal(await readFile(file, 'utf8'), 'kept on')
})

test('a test app that asks for autosave gets the product default, and the next one does not', {
  timeout: 90000,
}, async (t) => {
  const { file, setting, launch } = await profile(t)
  let app = await launch({ autosave: true })
  assert.equal(await setting(), null)
  assert.equal((await app.preferences()).enabled, true)
  await replaceRichText(app.page, app.rich, 'saved by default')
  await waitForAsync(
    app.page,
    async () => !(await window.hibi.getDocument()).dirty,
  )
  assert.equal(await readFile(file, 'utf8'), 'saved by default')
  await app.close()
  app = await launch()
  assert.deepEqual(await setting(), { enabled: false, delay: 2000 })
  await app.pill.getByText('Autosave off').waitFor()
})
