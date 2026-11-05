import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  autosaveOff,
  electron,
  waitForAsync,
  waitForFormattedEditor,
} from './electron.mjs'
import { pressShortcut, replaceRichText } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const day = 24 * 60 * 60 * 1000

async function note(t, text = 'original') {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-recovery-app-'))
  const file = join(profile, 'note.md')
  await writeFile(file, text)
  const running = new Set()
  const copies = () => readdir(join(profile, 'recovery')).catch(() => [])
  t.after(async () => {
    for (const app of running) await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  /** One launch over the profile; save prompts answer `response`. */
  async function launch(response = 1) {
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    running.add(app)
    await app.evaluate(
      ({ dialog }, { file, response }) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        })
        dialog.showMessageBox = async () => ({ response })
      },
      { file, response },
    )
    const page = await app.firstWindow()
    page.setDefaultTimeout(8000)
    await waitForFormattedEditor(app, page)
    const editor = page.getByRole('textbox', { name: /document editor/i })
    const shows = (text) =>
      waitForAsync(
        page,
        async (text) => (await window.hibi.getDocument()).markdown === text,
        text,
      )
    return {
      app,
      page,
      editor,
      shows,
      document: () =>
        page.evaluate(() =>
          window.hibi
            .getDocument()
            .then(({ name, dirty, canAutosave, markdown }) => ({
              name,
              dirty,
              canAutosave,
              markdown,
            })),
        ),
      async open(text) {
        await pressShortcut(app, `${mod}+o`)
        await shows(text)
        await page.waitForFunction(
          (text) =>
            document.querySelector('[aria-label="Document editor"]')
              ?.textContent === text,
          text,
        )
      },
      async edit(text) {
        await replaceRichText(page, editor, text)
        await shows(text)
      },
      /** Until a copy holding this text is on disk. */
      async kept(text) {
        const deadline = performance.now() + 8000
        for (;;) {
          for (const name of await copies())
            if (
              (
                await readFile(join(profile, 'recovery', name), 'utf8')
              ).includes(text)
            )
              return name
          assert.ok(performance.now() < deadline, `no copy holds ${text}`)
          await page.evaluate(
            () => new Promise((resolve) => setTimeout(resolve, 50)),
          )
        }
      },
      /** The real thing: main can do nothing about this signal. */
      async kill() {
        const child = app.process()
        running.delete(app)
        const gone = once(child, 'exit')
        child.kill('SIGKILL')
        await gone
      },
      async quit() {
        running.delete(app)
        await app.close()
      },
    }
  }
  return { profile, file, copies, launch }
}
async function later(page) {
  await page.getByRole('button', { name: /^decide later$/i }).click()
  await page.waitForFunction(() => !document.querySelector('dialog'))
}
/** Writes a copy as the journal does, for sizes and counts an editor is slow to reach. */
async function forge(
  profile,
  { name, text, path = null, named = false, offered },
) {
  await mkdir(join(profile, 'recovery'), { recursive: true })
  const sha = (value) => createHash('sha256').update(value).digest('hex')
  const line = JSON.stringify({
    format: 1,
    path,
    named,
    name,
    savedHash: sha(''),
    time: Date.now(),
    bytes: Buffer.byteLength(text),
  })
  const id = randomUUID()
  await writeFile(
    join(
      profile,
      'recovery',
      `${id}.1${offered === undefined ? '' : `.${offered}`}.recovery`,
    ),
    `${line}\n${text}${sha(line)}${sha(text)}\n`,
  )
  return id
}

test('after a killed process the prompt gets the text back, the file untouched, and a save clears it', {
  timeout: 120000,
}, async (t) => {
  const { file, copies, launch } = await note(t)
  const first = await launch()
  await autosaveOff(first.app, first.page)
  await first.open('original')
  await first.edit('typed and never saved')
  await first.kept('typed and never saved')
  await first.kill()
  assert.equal(await readFile(file, 'utf8'), 'original')

  const second = await launch()
  const prompt = second.page.getByRole('dialog', { name: /unsaved text/i })
  await prompt.getByText('note.md', { exact: true }).waitFor()
  await prompt.getByText('typed and never saved').waitFor()
  await prompt.getByText(/as unsaved changes/).waitFor()
  // Clearing saved undo steps must leave waiting unsaved text recoverable.
  await second.page.evaluate(() => window.hibi.clearUndoHistory())
  await second.page.getByRole('button', { name: 'Restore note.md' }).click()
  await second.shows('typed and never saved')
  const restored = await second.document()
  assert.equal(restored.name, 'note.md')
  assert.equal(restored.dirty, true)
  assert.equal(await readFile(file, 'utf8'), 'original')
  // Killed again now, it would still be there.
  await second.kept('typed and never saved')

  await pressShortcut(second.app, `${mod}+s`)
  await waitForAsync(
    second.page,
    async () => !(await window.hibi.getDocument()).dirty,
  )
  assert.equal(await readFile(file, 'utf8'), 'typed and never saved')
  const deadline = performance.now() + 5000
  while ((await copies()).length && performance.now() < deadline)
    await second.page.evaluate(() => new Promise((r) => setTimeout(r, 50)))
  assert.deepEqual(await copies(), [])
  await second.quit()

  const third = await launch()
  await third.page.waitForFunction(() => !document.querySelector('dialog'))
  assert.deepEqual(
    await third.page.evaluate(() => window.hibi.waitingRecovery()),
    { copies: [], newer: 0, openAtLaunch: false },
  )
})

test('typing nonstop loses about the last second to a kill', {
  timeout: 180000,
}, async (t) => {
  const losses = []
  const lostWords = []
  for (let round = 0; round < 3; round++) {
    const { launch } = await note(t, 'start ')
    const first = await launch()
    await autosaveOff(first.app, first.page)
    await first.open('start ')
    await first.edit('typing ')
    const typed = []
    const started = performance.now()
    // Random phase against the write timer.
    const length = 4000 + Math.random() * 1500
    for (let i = 0; performance.now() - started < length; i++) {
      await first.page.keyboard.type(`w${i} `)
      typed.push(performance.now())
    }
    const killedAt = performance.now()
    await first.kill()
    const second = await launch()
    await second.page.getByRole('button', { name: 'Restore note.md' }).click()
    await second.page.waitForFunction(() => !document.querySelector('dialog'))
    await waitForAsync(
      second.page,
      async () => (await window.hibi.getDocument()).dirty,
    )
    const { markdown } = await second.document()
    // The newest whole word: a write can fall between two keys of one.
    const last = Math.max(
      ...[...markdown.matchAll(/w(\d+) /g)].map((match) => Number(match[1])),
    )
    assert.ok(Number.isSafeInteger(last), 'recovered text ends in a word typed')
    // Every word before it is there, in order.
    for (let i = 0; i <= last; i += 50)
      assert.ok(markdown.includes(`w${i} `), `word ${i} is there`)
    losses.push(killedAt - typed[last])
    lostWords.push(typed.length - last - 1)
  }
  t.diagnostic(
    `text lost to a kill, ms: ${losses.map(Math.round).join(', ')}; whole words: ${lostWords.join(', ')}`,
  )
  // One write interval plus one write, with room for a loaded machine.
  assert.ok(Math.max(...losses) < 3000, losses.join(', '))
})

test('a copy cut off by the crash falls back to the whole one before it', {
  timeout: 90000,
}, async (t) => {
  const { profile, launch } = await note(t)
  const first = await launch()
  await autosaveOff(first.app, first.page)
  await first.open('original')
  await first.edit('the whole copy')
  const name = await first.kept('the whole copy')
  await first.kill()
  const bytes = await readFile(join(profile, 'recovery', name))
  const [id] = name.split('.')
  await writeFile(
    join(profile, 'recovery', `${id}.999.recovery`),
    bytes.subarray(0, bytes.length - 40),
  )
  const second = await launch()
  await second.page.getByRole('button', { name: 'Restore note.md' }).click()
  await second.shows('the whole copy')
})

test('over a file changed outside, a copy opens apart and autosave cannot replace the file', {
  timeout: 90000,
}, async (t) => {
  const { file, launch } = await note(t)
  const first = await launch()
  await autosaveOff(first.app, first.page)
  await first.open('original')
  await first.edit('my unsaved words')
  await first.kept('my unsaved words')
  await first.kill()
  await writeFile(file, 'another program wrote this')

  const second = await launch()
  await second.page.evaluate(() =>
    localStorage.setItem(
      'hibi:autosave',
      JSON.stringify({ enabled: true, delay: 1000 }),
    ),
  )
  await second.page.reload()
  await waitForFormattedEditor(second.app, second.page)
  await second.page
    .getByRole('dialog', { name: /unsaved text/i })
    .getByText(/file changed after/)
    .waitFor()
  await second.page.getByRole('button', { name: 'Restore note.md' }).click()
  await second.shows('my unsaved words')
  const opened = await second.document()
  assert.equal(opened.name, 'note (recovered).md')
  assert.equal(opened.canAutosave, false)
  await second.page
    .locator('[data-status-id="autosave"]')
    .getByText(/save first/)
    .waitFor()
  assert.equal(await readFile(file, 'utf8'), 'another program wrote this')
})

test('a note deleted outside and a note never saved both come back as new notes', {
  timeout: 90000,
}, async (t) => {
  const { file, launch } = await note(t)
  const first = await launch()
  await autosaveOff(first.app, first.page)
  await first.open('original')
  await first.edit('gone but kept')
  await first.kept('gone but kept')
  await pressShortcut(first.app, `${mod}+n`)
  await waitForAsync(
    first.page,
    async () => (await window.hibi.getDocument()).name === 'untitled.md',
  )
  await first.edit('a new draft')
  await first.kept('a new draft')
  await first.kill()
  await rm(file)

  const second = await launch()
  await second.page.getByRole('button', { name: 'Restore note.md' }).click()
  await second.shows('gone but kept')
  assert.equal((await second.document()).name, 'note (recovered).md')
  await second.page.getByRole('button', { name: 'Restore untitled.md' }).click()
  await second.shows('a new draft')
  assert.equal((await second.document()).name, 'untitled.md')
  assert.equal((await second.document()).dirty, true)
  await stat(file).then(
    () => assert.fail('restoring recreated the file'),
    () => {},
  )
})

test('don’t save leaves no copy, at tab close and at quit', {
  timeout: 90000,
}, async (t) => {
  const { copies, launch } = await note(t)
  const first = await launch()
  await autosaveOff(first.app, first.page)
  await first.open('original')
  await first.edit('thrown away in a tab')
  await first.kept('thrown away in a tab')
  await pressShortcut(first.app, `${mod}+w`)
  await waitForAsync(
    first.page,
    async () => !(await window.hibi.getDocument()).dirty,
  )
  const deadline = performance.now() + 5000
  while ((await copies()).length && performance.now() < deadline)
    await first.page.evaluate(() => new Promise((r) => setTimeout(r, 50)))
  assert.deepEqual(await copies(), [])
  await first.open('original')
  await first.edit('thrown away at quit')
  await first.kept('thrown away at quit')
  await first.quit()
  assert.deepEqual(await copies(), [])
})

test('discarding from the prompt deletes the copy; deciding later asks again', {
  timeout: 120000,
}, async (t) => {
  const { copies, launch } = await note(t)
  const first = await launch()
  await autosaveOff(first.app, first.page)
  await first.open('original')
  await first.edit('still undecided')
  await first.kept('still undecided')
  await first.kill()

  const second = await launch()
  await later(second.page)
  await second.quit()
  assert.equal((await copies()).length, 1)

  const third = await launch()
  await third.page.getByRole('button', { name: 'Discard note.md' }).click()
  await third.page.waitForFunction(() => !document.querySelector('dialog'))
  assert.deepEqual(await copies(), [])
})

test('with the setting on, a killed note opens without a prompt and stays protected', {
  timeout: 120000,
}, async (t) => {
  const { profile, file, launch } = await note(t)
  await writeFile(
    join(profile, 'recovery-settings.json'),
    JSON.stringify({
      keep: true,
      days: 30,
      megabytes: 512,
      openAtLaunch: true,
    }),
  )
  const first = await launch()
  await autosaveOff(first.app, first.page)
  await first.open('original')
  await first.edit('opened by itself')
  await first.kept('opened by itself')
  await first.kill()
  await writeFile(file, 'original')

  const second = await launch()
  await second.shows('opened by itself')
  assert.equal(await second.page.locator('dialog').count(), 0)
  await second.page.getByText('Hibi opened a note with unsaved text.').waitFor()
  const opened = await second.document()
  assert.equal(opened.name, 'note.md')
  assert.equal(opened.dirty, true)
  assert.equal(await readFile(file, 'utf8'), 'original')
  // Opening wrote no note: a second crash still has the text.
  await second.kept('opened by itself')
  await second.kill()
  const third = await launch()
  await third.shows('opened by itself')
})

test('with the setting on, many copies open up to the limit and the rest wait in the prompt', {
  timeout: 180000,
}, async (t) => {
  const { profile, launch } = await note(t)
  await writeFile(
    join(profile, 'recovery-settings.json'),
    JSON.stringify({
      keep: true,
      days: 30,
      megabytes: 512,
      openAtLaunch: true,
    }),
  )
  for (let i = 0; i < 25; i++)
    await forge(profile, { name: `draft ${i}.md`, text: `draft number ${i}` })
  const started = performance.now()
  const app = await launch()
  const prompt = app.page.getByRole('dialog', { name: /unsaved text/i })
  await prompt.waitFor({ timeout: 60000 })
  t.diagnostic(
    `20 copies open by ${Math.round(performance.now() - started)} ms`,
  )
  const { tabs } = await app.page.evaluate(() => window.hibi.getDocument())
  assert.equal(tabs.length, 20)
  assert.equal(await prompt.locator('[data-recovery-copy]').count(), 5)
})

test('the notice of copies opened at launch leads to them', {
  timeout: 60000,
}, async (t) => {
  const { profile, launch } = await note(t)
  await writeFile(
    join(profile, 'recovery-settings.json'),
    JSON.stringify({
      keep: true,
      days: 30,
      megabytes: 512,
      openAtLaunch: true,
    }),
  )
  await forge(profile, { name: 'older.md', text: 'older words' })
  await forge(profile, { name: 'newer.md', text: 'newer words' })
  const app = await launch()
  await app.page.getByText('Hibi opened 2 notes with unsaved text.').waitFor()
  const shown = (await app.document()).name
  assert.equal(
    (await app.page.evaluate(() => window.hibi.getDocument())).tabs.length,
    2,
  )
  await app.page.getByRole('button', { name: /show unsaved text/i }).click()
  await waitForAsync(
    app.page,
    async (shown) => (await window.hibi.getDocument()).name !== shown,
    shown,
  )
})

test('lowering the time limit says what goes; declined keeps it, accepted removes it', {
  timeout: 90000,
}, async (t) => {
  const { profile, copies, launch } = await note(t)
  await forge(profile, {
    name: 'old idea.md',
    text: 'waited ten days',
    offered: Date.now() - 10 * day,
  })
  const app = await launch(1)
  await later(app.page)
  await app.page.locator('[data-status-id="autosave"]').click()
  const select = app.page.locator('#recovery-days')
  assert.equal(await select.inputValue(), '30')
  // A limit the copy is still inside asks nothing.
  await select.selectOption('14')
  await waitForAsync(
    app.page,
    async () => (await window.hibi.getRecoverySettings()).days === 14,
  )
  assert.equal((await copies()).length, 1)

  await select.selectOption('7')
  const confirm = app.page.getByRole('dialog', { name: /recovery copy/i })
  await confirm.getByText(/old idea\.md/).waitFor()
  await confirm.getByRole('button', { name: /cancel/i }).click()
  await app.page.waitForFunction(
    () => document.querySelector('#recovery-days').value === '14',
  )
  assert.equal((await copies()).length, 1)

  await select.selectOption('7')
  await confirm.getByRole('button', { name: /^delete$/i }).click()
  await waitForAsync(
    app.page,
    async () => (await window.hibi.getRecoverySettings()).days === 7,
  )
  assert.deepEqual(await copies(), [])
})

test('lowering the size limit says what goes and removes the oldest, not an open note', {
  timeout: 120000,
}, async (t) => {
  const { profile, copies, launch } = await note(t)
  await forge(profile, {
    name: 'huge draft.md',
    text: 'x'.repeat(130 * 1024 * 1024),
  })
  const app = await launch(1)
  await later(app.page)
  await autosaveOff(app.app, app.page)
  await app.open('original')
  await app.edit('open and unsaved')
  const open = await app.kept('open and unsaved')
  await app.page.locator('[data-status-id="autosave"]').click()
  await app.page.locator('#recovery-megabytes').selectOption('128')
  const confirm = app.page.getByRole('dialog', { name: /recovery copy/i })
  await confirm.getByText(/huge draft\.md/).waitFor()
  await confirm.getByRole('button', { name: /^delete$/i }).click()
  await waitForAsync(
    app.page,
    async () => (await window.hibi.getRecoverySettings()).megabytes === 128,
  )
  assert.deepEqual(await copies(), [open])
})

test('turned off in settings, the waiting copy goes after saying so and typing writes none', {
  timeout: 90000,
}, async (t) => {
  const { profile, copies, launch } = await note(t)
  await forge(profile, { name: 'old idea.md', text: 'waiting' })
  const app = await launch(1)
  await later(app.page)
  await app.page.locator('[data-status-id="autosave"]').click()
  // The toggle follows the answer: it stays on until the copy is confirmed gone.
  await app.page.locator('#keep-recovery').click()
  const confirm = app.page.getByRole('dialog', { name: /recovery copy/i })
  await confirm.getByText(/old idea\.md/).waitFor()
  await confirm.getByRole('button', { name: /^delete$/i }).click()
  await waitForAsync(
    app.page,
    async () => !(await window.hibi.getRecoverySettings()).keep,
  )
  assert.deepEqual(await copies(), [])
  await app.page.getByRole('button', { name: /^back to app$/i }).click()
  await app.open('original')
  await app.edit('typed while off')
  // Twice the time a real copy takes in the tests above.
  await app.page.evaluate(
    () => new Promise((resolve) => setTimeout(resolve, 2500)),
  )
  assert.deepEqual(await copies(), [])
})
