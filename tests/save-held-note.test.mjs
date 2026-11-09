import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { electron, waitForAsync, waitForFormattedEditor } from './electron.mjs'
import { pressShortcut, replaceRichText } from './keyboard.mjs'

const windows = process.platform === 'win32'
const command = process.platform === 'darwin' ? 'Meta' : 'Control'
const limits = { timeout: 60000 }

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

/** Only Windows refuses a rename over an open file: elsewhere, main acts as it. */
async function pretending(app, path, share = 'Read') {
  await app.evaluate(
    (_electron, { path, share }) => {
      const fsp = process.getBuiltinModule('node:fs/promises')
      globalThis.heldNotes ??= {
        rename: fsp.rename,
        open: fsp.open,
        platform: process.platform,
        held: new Map(),
      }
      const state = globalThis.heldNotes
      const refuse = (code, target) =>
        Object.assign(new Error(`${code}: refused '${target}'`), { code })
      fsp.rename = async (from, to) => {
        if (state.held.has(to)) throw refuse('EPERM', to)
        return state.rename(from, to)
      }
      fsp.open = async (file, ...rest) => {
        if (state.held.get(file) === 'None') throw refuse('EBUSY', file)
        return state.open(file, ...rest)
      }
      state.held.set(path, share)
      process.getBuiltinModule('node:module').syncBuiltinESMExports()
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      })
    },
    { path, share },
  )
  return () =>
    app.evaluate((_electron, path) => {
      const fsp = process.getBuiltinModule('node:fs/promises')
      const state = globalThis.heldNotes
      state.held.delete(path)
      if (state.held.size) return
      fsp.rename = state.rename
      fsp.open = state.open
      process.getBuiltinModule('node:module').syncBuiltinESMExports()
      Object.defineProperty(process, 'platform', {
        value: state.platform,
        configurable: true,
      })
    }, path)
}

async function open(t, { autosave = false, notes = ['note.md'] } = {}) {
  const folder = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-held-note-')),
  )
  const file = join(folder, notes[0])
  for (const note of notes) await writeFile(join(folder, note), note)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  const releases = []
  // First: a failed test must not leave the note held, or its folder stays.
  t.after(async () => {
    await Promise.all(releases.map((release) => release()))
    // A test can end with the app already gone: closing its window quits it.
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  // A closing window's failed save opens a native box only a person can close.
  await app.evaluate(({ dialog }) => {
    dialog.showErrorBox = () => {}
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  await waitForFormattedEditor(app, page)
  if (autosave) {
    await page.locator('[data-status-id="autosave"]').click()
    await page.getByRole('checkbox', { name: /^autosave$/i }).check()
    await page.getByLabel(/^save after$/i).selectOption('1000')
    await page.getByRole('button', { name: /^back to app$/i }).click()
  }
  const shows = (text) =>
    page.waitForFunction(
      (text) =>
        document.querySelector('[aria-label="Document editor"]')
          ?.textContent === text,
      text,
    )
  for (const note of notes.toReversed()) {
    await app.evaluate(
      ({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        })
      },
      join(folder, note),
    )
    await pressShortcut(app, `${command}+o`)
    await shows(note)
  }
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
  const hold = async (share, path = file) => {
    const release = await (windows
      ? holding(path, share)
      : pretending(app, path, share))
    releases.push(release)
    return release
  }
  // Marked read-only. Windows refuses a rename over that with no program involved.
  const readOnly = async () => {
    await chmod(file, 0o444)
    const release = windows ? () => {} : await pretending(app, file)
    const undo = async () => {
      await release()
      await chmod(file, 0o666)
    }
    releases.push(undo)
    return undo
  }
  const notice = (name = notes[0]) =>
    page.getByRole('status').filter({
      hasText: `Another program is using ${name}. Hibi keeps trying to save it.`,
    })
  const status = page.locator('[data-status-id="autosave"]')
  // A refused attempt changes nothing else a test can see. No public path
  // shows it, so this reads each one's answer where it leaves main.
  const watchAttempts = () =>
    app.evaluate(({ ipcMain }) => {
      globalThis.attempts = []
      const handler = ipcMain._invokeHandlers.get('document:autosave')
      ipcMain._invokeHandlers.set('document:autosave', async (...args) => {
        try {
          const result = await handler(...args)
          globalThis.attempts.push(result?.status)
          return result
        } catch (error) {
          globalThis.attempts.push(String(error))
          throw error
        }
      })
    })
  const attempts = () => app.evaluate(() => globalThis.attempts)
  const moreAttempts = (seen, timeout = 20000) =>
    waitForAsync(
      app,
      (_electron, seen) => globalThis.attempts.length > seen,
      seen,
      {
        label: `more than ${seen} autosave attempts`,
        timeout,
      },
    )
  return {
    app,
    page,
    folder,
    file,
    edit,
    saved,
    shows,
    hold,
    readOnly,
    notice,
    status,
    watchAttempts,
    attempts,
    moreAttempts,
  }
}

test(
  'a save says when a program holds the note, and stops saying when it lands',
  limits,
  async (t) => {
    const { app, page, edit, saved, hold, notice } = await open(t)
    await edit('saved')
    const release = await hold()
    const started = performance.now()
    await pressShortcut(app, `${command}+s`)
    await notice().waitFor()
    const shown = performance.now() - started
    assert.ok(shown >= 1000 && shown < 8000, `shown after ${shown} ms`)
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).dirty,
      true,
    )
    await release()
    await saved('saved')
    await page.locator('.toast').waitFor({ state: 'detached' })
  },
)

test(
  'a save says the same about a program that shares nothing',
  limits,
  async (t) => {
    const { app, page, edit, saved, hold, notice } = await open(t)
    await edit('saved')
    const release = await hold('None')
    await pressShortcut(app, `${command}+s`)
    await notice().waitFor()
    await release()
    await saved('saved')
    await page.locator('.toast').waitFor({ state: 'detached' })
  },
)

test(
  'a save a program keeps refusing says why and loses nothing',
  limits,
  async (t) => {
    const { app, page, folder, file, edit, saved, hold, notice } = await open(t)
    await edit('kept')
    const release = await hold()
    await pressShortcut(app, `${command}+s`)
    await notice().waitFor()
    // Past how long a notice usually stays: the wait is 10 s.
    await delay(6000)
    assert.equal(await notice().count(), 1)
    await page.getByText(/could not save because another program/i).waitFor()
    await notice().waitFor({ state: 'detached' })
    assert.equal(await page.getByText(/EPERM|\.tmp/).count(), 0)
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).dirty,
      true,
    )
    assert.equal(await readFile(file, 'utf8'), 'note.md')
    await release()
    assert.deepEqual((await readdir(folder)).sort(), ['note.md', 'profile'])
    await pressShortcut(app, `${command}+s`)
    await saved('kept')
  },
)

test(
  'quitting during a held save shows what it waits for',
  limits,
  async (t) => {
    const { app, page, file, edit, hold, notice } = await open(t)
    await edit('running save')
    const release = await hold()
    // The first refused rename proves main owns the save before closing.
    await app.evaluate((_electron, file) => {
      const fsp = process.getBuiltinModule('node:fs/promises')
      const rename = fsp.rename
      globalThis.heldSaveStarted = false
      fsp.rename = async (from, to) => {
        try {
          return await rename(from, to)
        } catch (error) {
          if (to === file) {
            fsp.rename = rename
            process.getBuiltinModule('node:module').syncBuiltinESMExports()
            globalThis.heldSaveStarted = true
          }
          throw error
        }
      }
      process.getBuiltinModule('node:module').syncBuiltinESMExports()
    }, file)
    await pressShortcut(app, `${command}+s`)
    await waitForAsync(app, () => globalThis.heldSaveStarted)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].close()
    })
    await notice().waitFor()
    const closed = page.waitForEvent('close')
    await release()
    await closed
    assert.equal(await readFile(file, 'utf8'), 'running save')
  },
)

test('Save at the quit prompt says what it waits for', limits, async (t) => {
  const { app, page, file, edit, hold, notice } = await open(t)
  await edit('prompted save')
  const release = await hold()
  await app.evaluate(({ BrowserWindow, dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 })
    BrowserWindow.getAllWindows()[0].close()
  })
  await notice().waitFor()
  assert.equal(await readFile(file, 'utf8'), 'note.md')
  const closed = page.waitForEvent('close')
  await release()
  await closed
  assert.equal(await readFile(file, 'utf8'), 'prompted save')
})

test(
  'autosave keeps trying while a program holds the note',
  limits,
  async (t) => {
    const { page, file, edit, saved, hold, status } = await open(t, {
      autosave: true,
    })
    const release = await hold()
    await edit('held')
    await status.getByText('Autosave · retrying').waitFor()
    assert.equal(await readFile(file, 'utf8'), 'note.md')
    await release()
    await saved('held')
    await status.getByText('Autosave · saved').waitFor()
    assert.equal(await page.locator('.toast').count(), 0)
  },
)

test(
  'autosave says so after a minute of refusals, once, then tries every 30 s',
  limits,
  async (t) => {
    const { page, edit, saved, hold, notice, status, ...rest } = await open(t, {
      autosave: true,
    })
    const { watchAttempts, attempts, moreAttempts } = rest
    await watchAttempts()
    await page.clock.install()
    const release = await hold()
    await edit('held')
    await status.getByText('Autosave · retrying').waitFor()
    await page.clock.fastForward(50000)
    await moreAttempts((await attempts()).length)
    assert.equal(await page.locator('.toast').count(), 0)
    await page.clock.fastForward(10000)
    await notice().waitFor()
    // No attempt in what used to be two delays, typing or not.
    const seen = (await attempts()).length
    await delay(2500)
    assert.equal((await attempts()).length, seen)
    await page.clock.fastForward(20000)
    await edit('held and typing')
    await delay(2500)
    assert.equal((await attempts()).length, seen)
    // 30 s from the last attempt, well short of 30 s from the typing.
    await page.clock.fastForward(12000)
    await moreAttempts(seen, 10000)
    await delay(500)
    assert.equal(await page.locator('.toast').count(), 1)
    assert.deepEqual([...new Set(await attempts())], ['held'])
    await release()
    await page.clock.fastForward(30000)
    await saved('held and typing')
    await notice().waitFor({ state: 'detached' })
    await status.getByText('Autosave · saved').waitFor()
  },
)

test(
  'a manual save ends what autosave said about a held note',
  limits,
  async (t) => {
    const { app, page, edit, saved, hold, notice, status } = await open(t, {
      autosave: true,
    })
    await page.clock.install()
    const release = await hold()
    await edit('held')
    await status.getByText('Autosave · retrying').waitFor()
    await page.clock.fastForward(60000)
    await notice().waitFor()
    await release()
    await pressShortcut(app, `${command}+s`)
    await saved('held')
    await page.locator('.toast').waitFor({ state: 'detached' })
    await status.getByText('Autosave · saved').waitFor()
  },
)

test(
  'text put back, a turned-off autosave or a conflict ends what autosave said',
  limits,
  async (t) => {
    const { page, file, edit, hold, notice, status } = await open(t, {
      autosave: true,
    })
    await page.clock.install()
    const release = await hold()
    const said = async (text) => {
      await edit(text)
      await status.getByText('Autosave · retrying').waitFor()
      await page.clock.fastForward(60000)
      await notice().waitFor()
    }
    const turnAutosave = async (on) => {
      await status.click()
      await page.getByRole('checkbox', { name: /^autosave$/i }).setChecked(on)
      await page.getByRole('button', { name: /^back to app$/i }).click()
    }
    await said('held')
    await edit('note.md')
    await notice().waitFor({ state: 'detached' })
    await status.getByText('Autosave · saved').waitFor()
    await said('held again')
    await turnAutosave(false)
    await notice().waitFor({ state: 'detached' })
    await status.getByText('Autosave off').waitFor()
    await turnAutosave(true)
    await said('held once more')
    await release()
    await writeFile(file, 'outside')
    await page.clock.fastForward(30000)
    await status.getByText('Autosave · paused').waitFor()
    await notice().waitFor({ state: 'detached' })
    assert.equal(await readFile(file, 'utf8'), 'outside')
  },
)

test(
  'two held tabs each get their turn, their own status and their own notice',
  limits,
  async (t) => {
    const { app, page, folder, edit, hold, shows, notice, status, ...rest } =
      await open(t, { autosave: true, notes: ['a.md', 'b.md'] })
    const { watchAttempts, attempts, moreAttempts } = rest
    await watchAttempts()
    await page.clock.install()
    const a = join(folder, 'a.md')
    const releases = [
      await hold(undefined, a),
      await hold(undefined, join(folder, 'b.md')),
    ]
    await edit('a edited')
    await status.getByText('Autosave · retrying').waitFor()
    await page.getByRole('tab', { name: 'b.md' }).click()
    await shows('b.md')
    await edit('b edited')
    await status.getByText('Autosave · retrying').waitFor()
    await page.evaluate(() => {
      window.labels = new Set()
      new MutationObserver(() =>
        window.labels.add(
          document.querySelector('[data-status-id="autosave"]')?.textContent,
        ),
      ).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      })
    })
    const before = (await attempts()).length
    await moreAttempts(before + 2)
    // One at a time: a tab's attempt doesn't run into the other's and get skipped.
    assert.deepEqual([...new Set((await attempts()).slice(before))], ['held'])
    assert.deepEqual(
      await page.evaluate(() =>
        [...window.labels].filter((text) => text !== 'Autosave · retrying'),
      ),
      [],
    )
    await page.clock.fastForward(60000)
    await notice('a.md').waitFor()
    await notice('b.md').waitFor()
    // Showing the other held tab shows it retrying, 30 s before its next turn.
    await page.getByRole('tab', { name: 'a.md' }).click()
    await shows('a edited')
    assert.equal(await status.textContent(), 'Autosave · retrying')
    // A tab that closes takes its notice along, shown or not.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await page.getByRole('button', { name: 'Close b.md' }).click()
    await notice('b.md').waitFor({ state: 'detached' })
    await notice('a.md').waitFor()
    await releases[0]()
    await page.clock.fastForward(30000)
    await waitForAsync(
      page,
      async () => !(await window.hibi.getDocument()).dirty,
    )
    assert.equal(await readFile(a, 'utf8'), 'a edited')
    await notice('a.md').waitFor({ state: 'detached' })
  },
)

test(
  'a held tab does not hold up the autosave of a later one',
  limits,
  async (t) => {
    // Tabs are tried in the order they opened: the held one comes first.
    const { page, folder, edit, hold, shows, status } = await open(t, {
      autosave: true,
      notes: ['later.md', 'first.md'],
    })
    await page.getByRole('tab', { name: 'first.md' }).click()
    await shows('first.md')
    await hold(undefined, join(folder, 'first.md'))
    await edit('first edited')
    await status.getByText('Autosave · retrying').waitFor()
    await page.getByRole('tab', { name: 'later.md' }).click()
    await shows('later.md')
    await edit('later edited')
    await waitForAsync(
      page,
      async () => !(await window.hibi.getDocument()).dirty,
    )
    assert.equal(
      await readFile(join(folder, 'later.md'), 'utf8'),
      'later edited',
    )
  },
)

test(
  'a tab after two held ones gets its turn before their notices',
  limits,
  async (t) => {
    // Tabs are tried in the order they opened: the free one comes last.
    const { page, folder, edit, hold, shows, status } = await open(t, {
      autosave: true,
      notes: ['free.md', 'b.md', 'a.md'],
    })
    for (const note of ['a.md', 'b.md']) {
      await page.getByRole('tab', { name: note }).click()
      await shows(note)
      await hold(undefined, join(folder, note))
      await edit(`${note} edited`)
      await status.getByText('Autosave · retrying').waitFor()
    }
    await page.getByRole('tab', { name: 'free.md' }).click()
    await shows('free.md')
    await edit('free edited')
    await waitForAsync(
      page,
      async () => !(await window.hibi.getDocument()).dirty,
      undefined,
      { timeout: 30000 },
    )
    assert.equal(await readFile(join(folder, 'free.md'), 'utf8'), 'free edited')
  },
)

test(
  'turning autosave off during an attempt ends the attempts',
  limits,
  async (t) => {
    const { app, page, file, edit, hold, status, ...rest } = await open(t, {
      autosave: true,
    })
    const { watchAttempts, attempts, moreAttempts } = rest
    await watchAttempts()
    await page.clock.install()
    const release = await hold()
    await edit('held')
    await status.getByText('Autosave · retrying').waitFor()
    // The next attempt waits in main until autosave is off.
    await app.evaluate(({ ipcMain }) => {
      const channel = 'document:autosave'
      const handler = ipcMain._invokeHandlers.get(channel)
      globalThis.attemptGate = {}
      ipcMain._invokeHandlers.set(channel, async (...args) => {
        ipcMain._invokeHandlers.set(channel, handler)
        await new Promise((go) => {
          globalThis.attemptGate.go = go
        })
        return handler(...args)
      })
    })
    await waitForAsync(app, () => !!globalThis.attemptGate.go, undefined, {
      label: 'an attempt under way',
    })
    await status.click()
    await page.getByRole('checkbox', { name: /^autosave$/i }).setChecked(false)
    await page.getByRole('button', { name: /^back to app$/i }).click()
    await status.getByText('Autosave off').waitFor()
    const seen = (await attempts()).length
    await app.evaluate(() => globalThis.attemptGate.go())
    await moreAttempts(seen)
    const ended = (await attempts()).length
    await page.clock.fastForward(61000)
    await delay(2500)
    assert.equal((await attempts()).length, ended)
    assert.equal(await page.locator('.toast').count(), 0)
    await release()
    await page.clock.fastForward(31000)
    await delay(1000)
    assert.equal(await readFile(file, 'utf8'), 'note.md')
    await status.getByText('Autosave off').waitFor()
  },
)

test(
  'autosave firing behind a close prompt is not paused by it',
  limits,
  async (t) => {
    const { app, edit, saved, hold, status, watchAttempts, attempts } =
      await open(t, { autosave: true })
    await watchAttempts()
    const release = await hold()
    await edit('held')
    await status.getByText('Autosave · retrying').waitFor()
    await app.evaluate(({ BrowserWindow, dialog }) => {
      dialog.showMessageBox = () =>
        new Promise((answer) => {
          globalThis.answerPrompt = answer
        })
      BrowserWindow.getAllWindows()[0].close()
    })
    await waitForAsync(app, () => !!globalThis.answerPrompt, undefined, {
      label: 'the close prompt',
    })
    // The first answer that isn't a refusal comes from behind the prompt.
    await waitForAsync(
      app,
      () => globalThis.attempts.at(-1) !== 'held',
      undefined,
      { label: 'an attempt behind the close prompt' },
    )
    assert.equal((await attempts()).at(-1), 'skipped')
    await release()
    await app.evaluate(() => globalThis.answerPrompt({ response: 2 }))
    await saved('held')
    await status.getByText('Autosave · saved').waitFor()
  },
)

test(
  'a save to a read-only file says so at once and loses nothing',
  limits,
  async (t) => {
    const { app, page, folder, file, edit, saved, readOnly, notice } =
      await open(t)
    await edit('kept')
    const undo = await readOnly()
    const started = performance.now()
    await pressShortcut(app, `${command}+s`)
    await page
      .getByRole('alert')
      .filter({
        hasText: 'Could not save note.md because it is marked read-only',
      })
      .waitFor()
    const shown = performance.now() - started
    assert.ok(shown < 5000, `shown after ${shown} ms`)
    assert.equal(await notice().count(), 0)
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).dirty,
      true,
    )
    assert.equal(await readFile(file, 'utf8'), 'note.md')
    assert.deepEqual((await readdir(folder)).sort(), ['note.md', 'profile'])
    await undo()
    await pressShortcut(app, `${command}+s`)
    await saved('kept')
  },
)

test(
  'autosave on a read-only file says so at once and picks up when that ends',
  limits,
  async (t) => {
    const { page, folder, edit, saved, readOnly, status, ...rest } = await open(
      t,
      { autosave: true },
    )
    const { watchAttempts, attempts } = rest
    await watchAttempts()
    await page.clock.install()
    const undo = await readOnly()
    await edit('kept')
    const said = page.getByRole('status').filter({
      hasText: 'Could not save note.md because it is marked read-only',
    })
    await said.waitFor()
    await status.getByText('Autosave · retrying').waitFor()
    assert.match(
      await status.getAttribute('data-tooltip'),
      /Could not save note\.md because it is marked read-only/,
    )
    const seen = (await attempts()).length
    await delay(2500)
    assert.equal((await attempts()).length, seen)
    assert.deepEqual((await readdir(folder)).sort(), ['note.md', 'profile'])
    await undo()
    await page.clock.fastForward(30000)
    await saved('kept')
    await said.waitFor({ state: 'detached' })
    await status.getByText('Autosave · saved').waitFor()
  },
)
