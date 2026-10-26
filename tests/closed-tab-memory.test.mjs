import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('closing a large note releases its source and editor from the renderer heap', {
  timeout: 180000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-closed-tab-memory-'))
  const size = 16 * 1024 * 1024
  const line = 'a line of a large note that is closed again 0123456789\n'
  await writeFile(
    join(root, 'large.md'),
    line.repeat(Math.ceil(size / line.length)),
  )
  await writeFile(join(root, 'small.md'), 'small note\n')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  const cdp = await page.context().newCDPSession(page)
  const heap = async () => {
    for (let pass = 0; pass < 3; pass++)
      await cdp.send('HeapProfiler.collectGarbage')
    return (await cdp.send('Runtime.getHeapUsage')).usedSize
  }
  const tabs = () => page.getByRole('tab').count()
  const open = async (name, editor) => {
    await app.evaluate(
      ({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        })
      },
      join(root, name),
    )
    const count = await tabs()
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      (expected) =>
        document.querySelectorAll('[role="tab"]').length === expected,
      count + 1,
    )
    await waitForDocumentEditor(app, page, editor)
  }
  await open('small.md')
  const before = await heap()
  // A note this large opens in the source editor.
  await open('large.md', { name: 'Markdown editor', timeout: 120000 })
  assert.ok((await heap()) - before > size, 'the large note is loaded')
  const count = await tabs()
  await clickMenu(app, 'Close tab')
  await waitForAsync(
    page,
    (expected) => document.querySelectorAll('[role="tab"]').length === expected,
    count - 1,
  )
  await waitForDocumentEditor(app, page)
  // The closed note's source alone is as large as the note.
  const retained = (await heap()) - before
  assert.ok(
    retained < size / 2,
    `${(retained / 1048576).toFixed(1)} MiB stayed after closing a ${size / 1048576} MiB note`,
  )
})

test('closing a large startup note releases it, though early renders still hold its state', {
  timeout: 180000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-closed-startup-memory-'))
  const size = 32 * 1024 * 1024
  const line = 'a line of a large startup note that is closed 0123456789\n'
  await writeFile(
    join(root, 'large.md'),
    line.repeat(Math.ceil(size / line.length)),
  )
  await writeFile(join(root, 'small.md'), 'small note\n')
  const app = await electron.launch({
    args: [
      resolve('.'),
      `--user-data-dir=${join(root, 'profile')}`,
      join(root, 'large.md'),
    ],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const stale = []
  page.on('pageerror', (error) => stale.push(String(error)))
  page.on('console', (message) => {
    if (/StaleDocumentError|This tab is closed/.test(message.text()))
      stale.push(message.text())
  })
  // A note this large opens in the source editor.
  await waitForDocumentEditor(app, page, {
    name: 'Markdown editor',
    timeout: 120000,
  })
  await app.evaluate(
    ({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    },
    join(root, 'small.md'),
  )
  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    () => document.querySelectorAll('[role="tab"]').length === 2,
  )
  await waitForDocumentEditor(app, page)
  await page.getByRole('button', { name: 'Close large.md' }).click()
  await waitForAsync(
    page,
    () => document.querySelectorAll('[role="tab"]').length === 1,
  )
  await waitForDocumentEditor(app, page)
  const cdp = await page.context().newCDPSession(page)
  for (let pass = 0; pass < 3; pass++)
    await cdp.send('HeapProfiler.collectGarbage')
  const { usedSize } = await cdp.send('Runtime.getHeapUsage')
  // The closed note's source alone is as large as the note.
  assert.ok(
    usedSize < size,
    `${(usedSize / 1048576).toFixed(1)} MiB in use after closing a ${size / 1048576} MiB startup note`,
  )
  assert.deepEqual(stale, [])
})
