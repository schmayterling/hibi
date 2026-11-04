import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync, waitForFormattedEditor } from './electron.mjs'
import { pressShortcut, replaceRichText } from './keyboard.mjs'

// Only Windows refuses a rename over a file another program has open.
const windows = { skip: process.platform !== 'win32', timeout: 60000 }

/** A second program with the note open for reading, until released. */
async function holding(path, share = 'Read') {
  const holder = spawn(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$f=[IO.File]::Open('${path}','Open','Read','${share}');[Console]::Out.WriteLine('HELD');[Console]::Out.Flush();[void][Console]::In.ReadLine();$f.Close()`,
    ],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  )
  const exited = new Promise((done) => holder.on('exit', done))
  await new Promise((done, fail) => {
    holder.stdout.on('data', done)
    exited.then(() => fail(new Error('the holding program exited')))
  })
  let released = false
  return () => {
    if (!released) holder.stdin.write('\n')
    released = true
    return exited
  }
}

async function open(t, autosave = false) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-held-note-'))
  const file = join(folder, 'note.md')
  await writeFile(file, 'original')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  const releases = []
  // First: a failed test must not leave the note held, or its folder stays.
  t.after(async () => {
    await Promise.all(releases.map((release) => release()))
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  await waitForFormattedEditor(app, page)
  if (autosave) {
    await page.locator('[data-status-id="autosave"]').click()
    await page.getByRole('checkbox', { name: /^autosave$/i }).check()
    await page.getByLabel(/^save after$/i).selectOption('1000')
    await page.getByRole('button', { name: /^back to app$/i }).click()
  }
  await pressShortcut(app, 'Control+o')
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Document editor"]')?.textContent ===
      'original',
  )
  const edit = async (text) => {
    await replaceRichText(
      page,
      page.getByRole('textbox', { name: /document editor/i }),
      text,
    )
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
  }
  const saved = (text) =>
    waitForAsync(
      page,
      async () => !(await window.hibi.getDocument()).dirty,
    ).then(async () => {
      assert.equal(await readFile(file, 'utf8'), text)
    })
  const hold = async (share) => {
    const release = await holding(file, share)
    releases.push(release)
    return release
  }
  return { app, page, folder, file, edit, saved, hold }
}

test('a save waits out a program holding the note', windows, async (t) => {
  const { app, page, edit, saved, hold } = await open(t)
  await edit('saved')
  const release = await hold()
  await pressShortcut(app, 'Control+s')
  // Past where a save used to give up.
  await new Promise((done) => setTimeout(done, 3000))
  await release()
  await saved('saved')
  assert.equal(await page.locator('.toast').count(), 0)
})

test('a save waits out a program that shares nothing', windows, async (t) => {
  const { app, page, edit, saved, hold } = await open(t)
  await edit('saved')
  const release = await hold('None')
  await pressShortcut(app, 'Control+s')
  await new Promise((done) => setTimeout(done, 3000))
  assert.equal(await page.locator('.toast').count(), 0)
  await release()
  await saved('saved')
  assert.equal(await page.locator('.toast').count(), 0)
})

test(
  'a save a program keeps refusing says why and loses nothing',
  windows,
  async (t) => {
    const { app, page, folder, file, edit, saved, hold } = await open(t)
    await edit('kept')
    const release = await hold()
    await pressShortcut(app, 'Control+s')
    await page.getByText(/another program is using this file/i).waitFor()
    assert.equal(await page.getByText(/EPERM|\.tmp/).count(), 0)
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).dirty,
      true,
    )
    assert.equal(await readFile(file, 'utf8'), 'original')
    await release()
    assert.deepEqual((await readdir(folder)).sort(), ['note.md', 'profile'])
    await pressShortcut(app, 'Control+s')
    await saved('kept')
  },
)

test(
  'autosave keeps trying while a program holds the note',
  windows,
  async (t) => {
    const { page, file, edit, saved, hold } = await open(t, true)
    const status = page.locator('[data-status-id="autosave"]')
    const release = await hold()
    await edit('held')
    await status.getByText('Autosave · retrying').waitFor()
    assert.equal(await readFile(file, 'utf8'), 'original')
    await release()
    await saved('held')
    await status.getByText('Autosave · saved').waitFor()
  },
)
