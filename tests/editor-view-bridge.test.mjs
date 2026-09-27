import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('installed addon addresses source and rich selections by live view', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-editor-view-api-'))
  const addon = join(profile, 'installed-addons', 'view-probe')
  await mkdir(addon, { recursive: true })
  const first = join(profile, 'first.md')
  const second = join(profile, 'second.md')
  const plain = join(profile, 'plain.txt')
  await writeFile(first, `# alpha\n\n${'word '.repeat(1200)}`)
  await writeFile(second, '# beta')
  await writeFile(plain, 'plain text')
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'view-probe',
      name: 'View probe',
      description: 'Editor view bridge test addon.',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      defaultEnabled: true,
      startup: 'background',
      capabilities: [],
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(addon, 'index.js'),
    `export default () => ({
      start(context) {
        const events = []
        context.editorViews.onDidChangeActive(view => events.push(['active', view]))
        context.editorViews.onDidChangeSelection(selection => events.push(['selection', selection]))
        window.viewProbe = {
          events,
          list: () => context.editorViews.list(),
          active: () => context.editorViews.getActive(),
          selection: view => context.editorViews.getSelection(view),
          set: selection => context.editorViews.setSelection(selection),
          reveal: position => context.editorViews.reveal(position),
        }
      },
      stop() { delete window.viewProbe },
    })`,
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'view-probe': true }),
  )
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
  await page.waitForFunction(() => !!window.viewProbe)
  async function open(file) {
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      })
    }, file)
    await clickMenu(app, 'Open…')
  }

  await open(first)
  await page.waitForFunction(() => {
    const view = window.viewProbe.active()
    return (
      view &&
      window.viewProbe.selection(view).ok &&
      window.viewProbe.selection(view).value.editor === 'rich'
    )
  })
  const rich = await page.evaluate(() => {
    const view = window.viewProbe.active()
    return window.viewProbe.selection(view).value
  })
  assert.equal((await page.evaluate(() => window.viewProbe.list())).length, 1)
  assert.equal(
    (
      await page.evaluate((selection) => window.viewProbe.set(selection), {
        ...rich,
        anchor: 2,
        head: 4,
      })
    ).ok,
    true,
  )
  assert.equal(
    (await page.evaluate((view) => window.viewProbe.selection(view), rich.view))
      .value.head,
    4,
  )
  assert.equal(
    (
      await page.evaluate((position) => window.viewProbe.reveal(position), {
        ...rich,
        position: 3,
      })
    ).ok,
    true,
  )
  await page.locator('.rich-pane').evaluate((pane) => {
    pane.scrollTop = 0
  })
  assert.equal(
    (
      await page.evaluate((position) => window.viewProbe.reveal(position), {
        ...rich,
        position: 5000,
      })
    ).ok,
    true,
  )
  assert.ok(
    (await page.locator('.rich-pane').evaluate((pane) => pane.scrollTop)) > 100,
  )

  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await page.waitForFunction(() => {
    const view = window.viewProbe.active()
    const result = view && window.viewProbe.selection(view)
    return result?.ok && result.value.editor === 'source'
  })
  const source = await page.evaluate(() => {
    const view = window.viewProbe.active()
    return window.viewProbe.selection(view).value
  })
  assert.equal(source.view.viewId, rich.view.viewId)
  assert.equal(
    (await page.evaluate((selection) => window.viewProbe.set(selection), rich))
      .code,
    'stale',
  )
  assert.equal(
    (
      await page.evaluate((selection) => window.viewProbe.set(selection), {
        ...source,
        anchor: 2,
        head: 5,
      })
    ).ok,
    true,
  )
  assert.equal(
    (
      await page.evaluate(
        (view) => window.viewProbe.selection(view),
        source.view,
      )
    ).value.head,
    5,
  )
  assert.equal(
    (
      await page.evaluate((position) => window.viewProbe.reveal(position), {
        ...source,
        position: 5,
      })
    ).ok,
    true,
  )

  await open(second)
  await page.waitForFunction((oldViewId) => {
    const active = window.viewProbe.active()
    return active && active.viewId !== oldViewId
  }, rich.view.viewId)
  assert.equal(
    (await page.evaluate((view) => window.viewProbe.selection(view), rich.view))
      .code,
    'stale',
  )
  await open(plain)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await page.waitForFunction(() => {
    const view = window.viewProbe.active()
    const result = view && window.viewProbe.selection(view)
    return result?.ok && result.value.editor === 'source'
  })
  const plainSelection = await page.evaluate(() => {
    const view = window.viewProbe.active()
    return window.viewProbe.selection(view).value
  })
  assert.equal(
    (
      await page.evaluate((selection) => window.viewProbe.set(selection), {
        ...plainSelection,
        anchor: 2,
        head: 4,
      })
    ).ok,
    true,
  )
  const events = await page.evaluate(() => window.viewProbe.events)
  assert.ok(events.some(([kind]) => kind === 'active'))
  assert.ok(events.some(([kind]) => kind === 'selection'))
})
