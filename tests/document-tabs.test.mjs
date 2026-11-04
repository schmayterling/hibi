import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { MEDIA_CHANNELS } from '../src/shared/media.ts'
import {
  electron,
  waitForDocumentEditor,
  waitForFormattedEditor,
} from './electron.mjs'
import {
  clickMenu,
  pressShortcut,
  redoKey,
  replaceRichText,
  splitTab,
} from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('disk refresh after focusing an older tab advances its revision', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-tab-revision-'))
  const a = join(root, 'a.md'),
    b = join(root, 'b.md')
  await writeFile(a, 'original a')
  await writeFile(b, 'original b')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForFormattedEditor(app, page)
  await waitForDocumentEditor(app, page)
  const open = async (file) => {
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      })
    }, file)
    return page.evaluate(() => window.hibi.openDocument())
  }
  const first = await open(a)
  const second = await open(b)
  const retained = await page.evaluate(
    (id) => window.hibi.selectDocumentTab(id),
    first.tabId,
  )
  assert.ok(retained.revision > second.revision)
  const focused = await page.evaluate(
    ({ tabId, revision, contentVersion }) =>
      window.hibi.focusDocumentTab(tabId, { revision, contentVersion }),
    second,
  )
  assert.equal(focused.revision, second.revision)
  await writeFile(a, 'updated a')
  const refreshed = await page.evaluate(
    (id) => window.hibi.selectDocumentTab(id),
    first.tabId,
  )
  assert.equal(refreshed.markdown, 'updated a')
  assert.ok(refreshed.contentVersion > retained.contentVersion)
  assert.ok(refreshed.revision > retained.revision)
})

test('an inactive journal edit survives a pending disk refresh', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-tab-refresh-'))
  const a = join(root, 'a.md'),
    b = join(root, 'b.md')
  await writeFile(a, 'original a')
  await writeFile(b, 'original b')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
        globalThis.reloadGate?.release()
        globalThis.reloadGate?.restore()
      })
      .catch(() => {})
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForFormattedEditor(app, page)
  await waitForDocumentEditor(app, page)
  const open = async (file) => {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    return page.evaluate(() => window.hibi.openDocument())
  }
  const first = await open(a)
  const second = await open(b)
  await app.evaluate(async (_, file) => {
    const { open, stat } = process.getBuiltinModule('node:fs/promises')
    const target = await stat(file)
    const handle = await open(file, 'r')
    const prototype = Object.getPrototypeOf(handle)
    await handle.close()
    const originalStat = prototype.stat,
      originalRead = prototype.read,
      handles = new WeakSet()
    let enter, release
    const entered = new Promise((resolve) => {
      enter = resolve
    })
    const released = new Promise((resolve) => {
      release = resolve
    })
    let blocked = true
    prototype.stat = async function (...args) {
      const info = await originalStat.apply(this, args)
      if (info.dev === target.dev && info.ino === target.ino) handles.add(this)
      return info
    }
    prototype.read = async function (...args) {
      if (blocked && handles.has(this)) {
        blocked = false
        enter()
        await released
      }
      return originalRead.apply(this, args)
    }
    globalThis.reloadGate = {
      entered,
      release,
      restore: () => {
        prototype.stat = originalStat
        prototype.read = originalRead
      },
    }
  }, a)
  const switching = assert.rejects(
    page.evaluate((id) => window.hibi.selectDocumentTab(id), first.tabId),
    /changed while switching tabs/,
  )
  await app.evaluate(() => globalThis.reloadGate.entered)
  const ack = await page.evaluate(
    (before) =>
      window.hibi.appendSourceOperation({
        document: { tabId: before.tabId, revision: before.revision },
        operationId: 'inactive-during-reload',
        baseVersion: before.contentVersion,
        contentVersion: before.contentVersion + 1,
        origin: 'source',
        historyGroup: 'typing',
        changes: [
          {
            from: before.markdown.length,
            to: before.markdown.length,
            insert: ' live',
          },
        ],
      }),
    first,
  )
  assert.equal(ack.tabId, first.tabId)
  await app.evaluate(() => globalThis.reloadGate.release())
  await switching
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabId,
    second.tabId,
  )
  await app.evaluate(() => globalThis.reloadGate.restore())
  const retained = await page.evaluate(
    (id) => window.hibi.selectDocumentTab(id),
    first.tabId,
  )
  assert.equal(retained.markdown, 'original a live')
  assert.equal(retained.dirty, true)
  assert.equal(await readFile(a, 'utf8'), 'original a')
})

test('overflowing tabs reveal close buttons and reorder without losing drafts', {
  timeout: 45000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-tab-overflow-'))
  const files = Array.from({ length: 8 }, (_, index) =>
    join(root, `note-${index}-with-a-long-filename.md`),
  )
  for (const file of files) await writeFile(file, 'saved note')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForFormattedEditor(app, page)
  page.setDefaultTimeout(6000)
  await waitForDocumentEditor(app, page)
  await page.setViewportSize({ width: 720, height: 600 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const open = async (file) => {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      basename(file),
    )
    await page.waitForFunction(
      () =>
        document.querySelector('.app').getAttribute('aria-busy') === 'false',
    )
  }
  for (const file of files.slice(0, -1)) await open(file)
  await page
    .locator('.document-tabs')
    .evaluate((strip) => strip.scrollTo({ left: 0, behavior: 'instant' }))
  await open(files.at(-1))
  await page.waitForFunction(() => {
    const strip = document.querySelector('.document-tabs')
    return (
      strip.scrollWidth > strip.clientWidth &&
      Math.abs(strip.scrollLeft - strip.scrollWidth + strip.clientWidth) < 1
    )
  })
  const fullyVisible = () =>
    page.waitForFunction(() => {
      const strip = document
        .querySelector('.document-tabs')
        .getBoundingClientRect()
      const tab = document.querySelector('.document-tab[data-active="true"]')
      const pill = tab.getBoundingClientRect(),
        close = tab.querySelector('.tab-close').getBoundingClientRect()
      return (
        pill.left >= strip.left - 1 &&
        pill.right <= strip.right + 1 &&
        close.right <= strip.right + 1
      )
    })
  await fullyVisible()
  await open(files[0])
  await fullyVisible()
  await replaceRichText(
    page,
    page.getByRole('textbox', { name: /document editor/i }),
    'keep this reordered draft',
  )
  let state = await page.evaluate(() => window.hibi.getDocument())
  const activeId = state.tabId,
    neighbor = state.tabs[1].id
  const active = page.locator(`[data-tab-id="${activeId}"]`)
  await active.press('Alt+Shift+ArrowRight')
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabs[1].id === id,
    activeId,
  )
  await page.waitForFunction(
    (id) =>
      document.querySelector('.document-tabs').children[1]?.dataset.tabKey ===
      id,
    activeId,
  )
  await fullyVisible()
  await page
    .locator('.document-tabs')
    .evaluate((strip) =>
      Promise.all(
        strip
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      ),
    )
  await page
    .locator(`[data-tab-key="${activeId}"]`)
    .dragTo(page.locator(`[data-tab-key="${neighbor}"]`), {
      targetPosition: { x: 8, y: 10 },
    })
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabs[0].id === id,
    activeId,
  )
  state = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(state.tabId, activeId)
  assert.equal(state.markdown, 'keep this reordered draft')
  assert.equal(state.tabs.length, files.length)
  await assert.rejects(
    page.evaluate(() => window.hibi.moveDocumentTab('missing', null)),
    /no longer open/,
  )
  await assert.rejects(
    page.evaluate((id) => window.hibi.moveDocumentTab(id, 'missing'), activeId),
    /no longer open/,
  )
  const order = state.tabs.map((tab) => tab.id)
  await page.reload()
  await waitForDocumentEditor(app, page)
  assert.deepEqual(
    await page
      .locator('.document-tab')
      .evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tabKey)),
    order,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'keep this reordered draft',
  )
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await open(files.at(-1))
  await fullyVisible()
  assert.equal(
    await page
      .locator('.document-tabs')
      .evaluate((strip) => getComputedStyle(strip).scrollBehavior),
    'auto',
  )
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const closingId = (await page.evaluate(() => window.hibi.getDocument())).tabId
  await page.locator(`[data-tab-key="${closingId}"] .tab-close`).click()
  await page
    .locator(`[data-tab-key="${closingId}"]`)
    .waitFor({ state: 'detached' })
  await fullyVisible()
})

test('single-file mode guards replacement, closes other tabs safely, and persists', {
  timeout: 45000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-single-file-'))
  const notes = join(root, 'notes')
  await mkdir(notes)
  const a = join(notes, 'a.md'),
    b = join(notes, 'b.md'),
    savedDraft = join(notes, 'saved.md')
  await writeFile(a, 'original a')
  await writeFile(b, 'original b')
  const launch = () =>
    electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
    })
  let app = await launch()
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  let page = await app.firstWindow()
  await waitForFormattedEditor(app, page)
  page.setDefaultTimeout(6000)
  await replaceRichText(
    page,
    page.getByRole('textbox', { name: /document editor/i }),
    'keep this draft',
  )
  await app.evaluate(
    ({ dialog }, { b, savedDraft }) => {
      globalThis.choice = 2
      dialog.showMessageBox = async () => ({ response: globalThis.choice })
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [b] })
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: savedDraft,
      })
    },
    { b, savedDraft },
  )
  await clickMenu(app, 'Open…')
  await page.getByRole('tab', { name: 'b.md', exact: true }).waitFor()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^editor$/i, exact: true }).click()
  await page.locator('#document-tabs').click()
  await page.waitForFunction(
    () => document.querySelector('.app').getAttribute('aria-busy') === 'false',
  )
  assert.equal(await page.locator('#document-tabs').isChecked(), true)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabs.length,
    2,
  )
  await app.evaluate(() => {
    globalThis.choice = 0
  })
  await page.locator('#document-tabs').click()
  await page.waitForFunction(
    () => !document.querySelector('#document-tabs').checked,
  )
  await page.waitForFunction(
    () =>
      document.querySelector('#document-tabs').getAttribute('aria-disabled') ===
      'false',
  )
  assert.equal(await readFile(savedDraft, 'utf8'), 'keep this draft')
  await page.keyboard.press('Escape')
  assert.equal(
    await page.getByRole('tablist', { name: 'Open tabs' }).count(),
    0,
  )
  assert.match(
    await page.locator('.single-document-title').innerText(),
    /b\.md/,
  )
  await replaceRichText(
    page,
    page.getByRole('textbox', { name: /document editor/i }),
    'changed b',
  )
  await page
    .locator('.single-document-title')
    .getByRole('status', { name: /unsaved changes/i })
    .waitFor()
  await app.evaluate(({ dialog }, notes) => {
    globalThis.choice = 2
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [notes],
    })
  }, notes)
  await page.evaluate(() => window.hibi.openWorkspace())
  assert.equal(
    await page.evaluate(() => window.hibi.openWorkspaceFile('a.md')),
    null,
  )
  let document = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(document.name, 'b.md')
  assert.equal(document.markdown, 'changed b')
  assert.equal(document.tabs.length, 1)
  await app.evaluate(() => {
    globalThis.choice = 0
  })
  document = await page.evaluate(() => window.hibi.openWorkspaceFile('a.md'))
  assert.equal(document.name, 'a.md')
  assert.equal(document.tabs.length, 1)
  assert.equal(await readFile(b, 'utf8'), 'changed b')
  await page.evaluate(() => window.hibi.updateDocument('changed a'))
  await assert.rejects(
    page.evaluate(() => window.hibi.openWorkspaceFile('missing.md')),
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'changed a',
  )
  await app.evaluate(() => {
    globalThis.choice = 2
  })
  assert.equal(await page.evaluate(() => window.hibi.newDocument()), null)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'changed a',
  )
  await app.evaluate(() => {
    globalThis.choice = 1
  })
  document = await page.evaluate(() => window.hibi.newDocument())
  assert.equal(document.markdown, '')
  assert.equal(document.tabs.length, 1)
  assert.equal(await readFile(a, 'utf8'), 'original a')
  await assert.rejects(
    page.evaluate(() => window.hibi.setTabsEnabled('invalid')),
    /Invalid tabs preference/,
  )
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  await waitForDocumentEditor(app, page)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabsEnabled,
    false,
  )
  assert.equal(
    await page.getByRole('tablist', { name: 'Open tabs' }).count(),
    0,
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^editor$/i, exact: true }).click()
  await page.locator('#document-tabs').click()
  await page.waitForFunction(
    () => document.querySelector('#document-tabs').checked,
  )
  await page.waitForFunction(
    () =>
      document.querySelector('#document-tabs').getAttribute('aria-disabled') ===
      'false',
  )
  await page.keyboard.press('Escape')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).tabsEnabled,
  )
  await clickMenu(app, 'New')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).tabs.length === 1,
  )
})

test('tab entry and exit animate, while reduced motion removes transitions', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-tab-motion-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForFormattedEditor(app, page)
  page.setDefaultTimeout(6000)
  await waitForDocumentEditor(app, page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await clickMenu(app, 'New')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).tabs.length === 1,
  )
  const first = (await page.evaluate(() => window.hibi.getDocument())).tabId
  const observe = (name) =>
    page.evaluate(
      ({ name, first }) => {
        window.tabMotion = null
        const observer = new MutationObserver(() => {
          const tab = [...document.querySelectorAll('.document-tab')].find(
            (tab) =>
              tab
                .querySelector('[data-tab-id]')
                ?.getAttribute('data-tab-id') !== first &&
              getComputedStyle(tab).animationName === name,
          )
          const animation = tab?.getAnimations()[0]
          if (!animation) return
          observer.disconnect()
          animation.pause()
          animation.currentTime = 80
          const style = getComputedStyle(tab)
          window.tabMotion = {
            opacity: Number(style.opacity),
            x: new DOMMatrixReadOnly(style.transform).m41,
          }
          animation.finish()
        })
        observer.observe(document.querySelector('.document-tabs'), {
          childList: true,
          subtree: true,
          attributes: true,
        })
      },
      { name, first },
    )
  await observe('tab-open')
  await clickMenu(app, 'New')
  await page.waitForFunction(() => window.tabMotion)
  let sample = await page.evaluate(() => window.tabMotion)
  assert.ok(
    sample.opacity > 0 && sample.opacity < 1 && sample.x < 0 && sample.x > -10,
  )
  await observe('tab-close')
  await page
    .getByRole('button', { name: /^close untitled\.md$/i })
    .last()
    .click()
  await page.waitForFunction(() => window.tabMotion)
  sample = await page.evaluate(() => window.tabMotion)
  assert.ok(
    sample.opacity > 0 && sample.opacity < 1 && sample.x < 0 && sample.x > -10,
  )
  await page.waitForFunction(
    () => !document.querySelector('.document-tab[data-closing="true"]'),
  )
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await clickMenu(app, 'New')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).tabs.length === 2,
  )
  assert.equal(
    await page
      .locator('.document-tab')
      .last()
      .evaluate((tab) => getComputedStyle(tab).animationName),
    'none',
  )
})

test('file tabs preserve independent drafts and guard closing, saving, and workspace mutations', {
  timeout: 40000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-tabs-'))
  const notes = join(root, 'notes')
  await mkdir(join(notes, 'folder'), { recursive: true })
  const a = join(notes, 'folder/a.md'),
    b = join(notes, 'b.md')
  await writeFile(a, 'original a')
  await writeFile(b, 'original b')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    globalThis.choices = []
    globalThis.choice = 2
    dialog.showMessageBox = async (_window, options) => {
      globalThis.choices.push(options.message)
      return { response: globalThis.choice }
    }
  })
  const page = await app.firstWindow()
  await waitForFormattedEditor(app, page)
  page.setDefaultTimeout(6500)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await waitForDocumentEditor(app, page)
  const read = () => page.evaluate(() => window.hibi.getDocument())
  const choose = (file) =>
    app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    }, file)
  const waitEditable = () => waitForDocumentEditor(app, page)
  await replaceRichText(page, rich, 'untitled draft')
  const untitled = (await read()).tabId
  await clickMenu(app, 'New')
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId !== id,
    untitled,
  )
  await page.locator(`[data-tab-id="${untitled}"]`).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'untitled draft',
  )
  await choose(a)
  await clickMenu(app, 'Open…')
  await page.getByRole('tab', { name: /^a\.md$/i, exact: true }).waitFor()
  await waitEditable()
  await replaceRichText(page, rich, 'draft a')
  const aTab = (await read()).tabId
  await choose(b)
  await clickMenu(app, 'Open…')
  await page.getByRole('tab', { name: /^b\.md$/i, exact: true }).waitFor()
  const bTab = (await read()).tabId
  assert.equal(
    await page
      .getByRole('button', { name: /^rename document$/i, exact: true })
      .count(),
    0,
  )
  await page.getByRole('tab', { name: /^b\.md$/i, exact: true }).dblclick()
  assert.equal(
    await page
      .getByRole('textbox', { name: /^file name$/i, exact: true })
      .count(),
    0,
  )
  assert.deepEqual(await app.evaluate(() => globalThis.choices), [])
  assert.equal((await read()).tabs.find((tab) => tab.id === aTab).dirty, true)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  )
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  )
  assert.equal((await read()).tabId, bTab)
  await page
    .getByRole('button', { name: /^close a\.md$/i, exact: true })
    .click()
  await page.waitForFunction(
    () => document.querySelector('.app').getAttribute('aria-busy') === 'false',
  )
  assert.equal(
    (await read()).tabs.some((tab) => tab.id === aTab),
    true,
  )
  await app.evaluate(() => {
    globalThis.choice = 0
  })
  await page
    .getByRole('button', { name: /^close a\.md$/i, exact: true })
    .click()
  await page
    .getByRole('tab', { name: /^a\.md$/i, exact: true })
    .waitFor({ state: 'hidden' })
  assert.equal(await readFile(a, 'utf8'), 'draft a')
  assert.equal((await read()).tabId, bTab)
  await page.locator(`[data-tab-id="${untitled}"]`).click()
  await waitEditable()
  await clickMenu(app, 'Save')
  await page
    .getByRole('alert')
    .filter({ hasText: /this file is open in another tab/i })
    .waitFor()
  assert.equal(await readFile(b, 'utf8'), 'original b')
  await choose(a)
  await clickMenu(app, 'Open…')
  await page.getByRole('tab', { name: /^a\.md$/i, exact: true }).waitFor()
  await waitEditable()
  await waitForAsync(page, async () => {
    const current = await window.hibi.getDocument()
    const editor = document.querySelector('[aria-label="Document editor"]')
    return (
      current.name === 'a.md' &&
      current.markdown === 'draft a' &&
      editor?.isContentEditable &&
      editor.textContent === 'draft a'
    )
  })
  await replaceRichText(page, rich, 'moved draft')
  await page.getByRole('tab', { name: /^b\.md$/i, exact: true }).click()
  await choose(notes)
  await page.evaluate(() => window.hibi.openWorkspace())
  await page.evaluate(() =>
    window.hibi.workspaceAction({
      action: 'rename',
      path: 'folder',
      destination: 'renamed',
    }),
  )
  const moved = (await read()).tabs.find((tab) => tab.name === 'a.md')
  await page.evaluate((id) => window.hibi.selectDocumentTab(id), moved.id)
  assert.equal((await read()).markdown, 'moved draft')
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(
    await readFile(join(notes, 'renamed/a.md'), 'utf8'),
    'moved draft',
  )
  await page.evaluate(() => window.hibi.updateDocument('do not delete yet'))
  await page.evaluate((id) => window.hibi.selectDocumentTab(id), bTab)
  await app.evaluate(() => {
    globalThis.choice = 2
  })
  assert.equal(
    await page.evaluate(() =>
      window.hibi.workspaceAction({ action: 'delete', path: 'renamed' }),
    ),
    null,
  )
  assert.equal(
    await readFile(join(notes, 'renamed/a.md'), 'utf8'),
    'moved draft',
  )
  const first = await page.evaluate(() =>
    window.hibi.workspaceAction({ action: 'new-file', path: '' }),
  )
  const second = await page.evaluate(() =>
    window.hibi.workspaceAction({ action: 'new-file', path: '' }),
  )
  assert.notEqual(first.path, second.path)
  assert.equal(
    (await page.evaluate(() => window.hibi.getWorkspace())).entries
      .flatMap((entry) => [entry, ...(entry.children ?? [])])
      .filter((entry) => entry.dirty).length,
    3,
  )
  await page.evaluate((path) => window.hibi.openWorkspaceFile(path), first.path)
  assert.equal((await read()).tabId, first.document.tabId)
  await assert.rejects(
    page.evaluate(() =>
      window.hibi.openWorkspaceFile('../notes/' + 'untitled.md'),
    ),
    /Choose a supported document inside this workspace\./,
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.selectDocumentTab('invented')),
    /no longer open/,
  )
  await app.evaluate(({ shell }) => {
    globalThis.choice = 1
    shell.trashItem = (path) =>
      process.getBuiltinModule('fs/promises').rm(path, { recursive: true })
  })
  await page.evaluate(() =>
    window.hibi.workspaceAction({ action: 'delete', path: 'renamed' }),
  )
  assert.equal(
    (await read()).tabs.some((tab) => tab.id === moved.id),
    false,
  )
  for (const tab of (await read()).tabs)
    await page.evaluate((id) => window.hibi.closeDocumentTab(id), tab.id)
  assert.equal((await read()).tabs.length, 0)
  assert.equal((await read()).markdown, '')
  await page.reload()
  await waitForDocumentEditor(app, page)
  await page.getByRole('region', { name: /start writing/i }).waitFor()
  const lastTab = (await read()).tabId
  await clickMenu(app, 'New')
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId !== id,
    lastTab,
  )
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+w' : 'Control+w',
  )
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).tabs.length === 0,
  )
  await page.getByRole('region', { name: /start writing/i }).waitFor()
})

test('source selection survives tab remounts with emoji and mixed line endings', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-source-bookmark-'))
  const first = join(root, 'first.md'),
    second = join(root, 'second.md')
  await writeFile(first, 'first\r\n😀second\nthird')
  await writeFile(second, 'another note')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForFormattedEditor(app, page)
  page.setDefaultTimeout(6000)
  await waitForDocumentEditor(app, page)
  const open = async (file) => {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      basename(file),
    )
    await page.waitForFunction(
      () =>
        document.querySelector('.app').getAttribute('aria-busy') === 'false',
    )
  }
  await open(first)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  const source = page.locator('.source-pane .cm-content')
  await page.waitForFunction(
    () => document.querySelector('.source-pane .cm-content')?.isContentEditable,
  )
  await source.focus()
  await source.press('ControlOrMeta+a')
  await source.press('ArrowLeft')
  for (let n = 0; n < 7; n++) await source.press('ArrowRight')
  for (let n = 0; n < 6; n++) await source.press('Shift+ArrowRight')
  assert.equal(await page.evaluate(() => getSelection().toString()), 'second')
  await open(second)
  await page.getByRole('tab', { name: 'first.md', exact: true }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'first.md',
  )
  await page.waitForFunction(
    () =>
      document.activeElement?.classList.contains('cm-content') &&
      getSelection().toString() === 'second',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'first\r\n😀second\nthird',
  )
})

test('five hundred tabs skip geometry for unchanged lists and read before writing', {
  timeout: 120000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-tab-scale-'))
  const root = join(temp, 'workspace')
  await mkdir(root, { recursive: true })
  const names = Array.from(
    { length: 500 },
    (_, index) => `note-${String(index).padStart(3, '0')}.md`,
  )
  for (const name of names) await writeFile(join(root, name), `# ${name}`)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForFormattedEditor(app, page)
  page.setDefaultTimeout(15000)
  await waitForDocumentEditor(app, page)
  await page.setViewportSize({ width: 1000, height: 600 })
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
  }, root)
  // Open every file in the main process, then mount all tabs in one reload.
  await page.evaluate(async (names) => {
    await window.hibi.openWorkspace()
    for (const name of names) await window.hibi.openWorkspaceFile(name)
  }, names)
  await page.reload()
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(
    (count) => document.querySelectorAll('.document-tab').length === count,
    names.length,
  )
  // Revealing the active tab is separate; count geometry reads of the other tabs.
  await page.evaluate(() => {
    const strip = document.querySelector('.document-tabs')
    const log = []
    window.tabGeometry = log
    for (const name of ['offsetLeft', 'offsetWidth']) {
      const { get } = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        name,
      )
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        get() {
          if (strip.contains(this) && this.dataset.active === 'false')
            log.push('read')
          return get.call(this)
        },
      })
    }
    const { setProperty } = CSSStyleDeclaration.prototype
    CSSStyleDeclaration.prototype.setProperty = function (name, ...rest) {
      if (name === '--tab-width') log.push('write')
      return setProperty.call(this, name, ...rest)
    }
    const app = document.querySelector('.app')
    window.tabBusy = 0
    new MutationObserver(() => {
      if (app.getAttribute('aria-busy') === 'true') window.tabBusy++
    }).observe(app, { attributes: true, attributeFilter: ['aria-busy'] })
  })
  const update = async (action) => {
    const busy = await page.evaluate(() => {
      window.tabGeometry.length = 0
      return window.tabBusy
    })
    await action()
    await page.waitForFunction(
      (busy) =>
        window.tabBusy > busy &&
        document.querySelector('.app').getAttribute('aria-busy') === 'false',
      busy,
    )
    return page.evaluate(() => {
      let wrote = false
      const result = { reads: 0, readsAfterWrites: 0 }
      for (const entry of window.tabGeometry) {
        if (entry === 'write') wrote = true
        else {
          result.reads++
          if (wrote) result.readsAfterWrites++
        }
      }
      return result
    })
  }
  const active = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(active.tabs.length, names.length)
  await app.evaluate(
    ({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    },
    join(root, active.name),
  )
  // Reopening the active file replaces the tab list with an equal one.
  assert.deepEqual(await update(() => clickMenu(app, 'Open…')), {
    reads: 0,
    readsAfterWrites: 0,
  })
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabId,
    active.tabId,
  )
  await page.locator(`[data-tab-id="${active.tabId}"]`).focus()
  const selected = await update(() => page.keyboard.press('ArrowLeft'))
  assert.notEqual(
    (await page.evaluate(() => window.hibi.getDocument())).tabId,
    active.tabId,
  )
  // One pass reads each other tab's position and width once, before any width is written.
  assert.deepEqual(selected, {
    reads: 2 * (names.length - 1),
    readsAfterWrites: 0,
  })
})

test('tab context menu closes tabs in bulk and disables impossible actions', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-tab-menu-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForFormattedEditor(app, page)
  page.setDefaultTimeout(6500)
  await waitForDocumentEditor(app, page)
  const read = () => page.evaluate(() => window.hibi.getDocument())
  const newTab = async () => {
    const before = (await read()).tabId
    await clickMenu(app, 'New')
    await waitForAsync(
      page,
      async (id) => (await window.hibi.getDocument()).tabId !== id,
      before,
    )
  }
  while ((await read()).tabs.length < 4) await newTab()
  const [a, b] = (await read()).tabs
  assert.ok(a && b)
  const openMenu = async (id) => {
    await page.locator(`[data-tab-id="${id}"]`).click({ button: 'right' })
    await page.getByRole('menu', { name: 'Tab actions' }).waitFor()
  }
  await openMenu(b.id)
  assert.equal(await page.getByRole('menuitem').count(), 4)
  assert.deepEqual(
    await page
      .getByRole('menuitem')
      .evaluateAll((items) => items.map((item) => item.disabled)),
    [false, false, false, false],
  )
  await page
    .getByRole('menuitem', { name: 'Close tabs to the right', exact: true })
    .click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).tabs.length === 2,
  )
  let current = await read()
  assert.deepEqual(
    current.tabs.map((tab) => tab.id),
    [a.id, b.id],
  )
  assert.equal(current.tabId, b.id)
  await openMenu(b.id)
  await page
    .getByRole('menuitem', { name: 'Close tabs to the left', exact: true })
    .click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).tabs.length === 1,
  )
  current = await read()
  assert.deepEqual(
    current.tabs.map((tab) => tab.id),
    [b.id],
  )
  assert.equal(current.tabId, b.id)
  await openMenu(b.id)
  assert.deepEqual(
    await page.getByRole('menuitem').evaluateAll((items) =>
      items.map((item) => ({
        disabled: item.disabled,
        text: item.textContent,
      })),
    ),
    [
      { disabled: false, text: 'Close tab' },
      { disabled: true, text: 'Close other tabs' },
      { disabled: true, text: 'Close tabs to the right' },
      { disabled: true, text: 'Close tabs to the left' },
    ],
  )
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.ui-menu:popover-open').count(), 0)
  await openMenu(b.id)
  await page.mouse.click(400, 500)
  assert.equal(await page.locator('.ui-menu:popover-open').count(), 0)
  assert.equal((await read()).tabs.length, 1)
})

test('context-menu bulk close confirms dirty tabs and cancels as a unit', {
  timeout: 40000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-tab-menu-dirty-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    globalThis.choices = []
    globalThis.choice = 2
    dialog.showMessageBox = async (_window, options) => {
      globalThis.choices.push(options.message)
      return { response: globalThis.choice }
    }
  })
  const page = await app.firstWindow()
  await waitForFormattedEditor(app, page)
  page.setDefaultTimeout(6500)
  await waitForDocumentEditor(app, page)
  const read = () => page.evaluate(() => window.hibi.getDocument())
  const newTab = async () => {
    const before = (await read()).tabId
    await clickMenu(app, 'New')
    await waitForAsync(
      page,
      async (id) => (await window.hibi.getDocument()).tabId !== id,
      before,
    )
  }
  while ((await read()).tabs.length < 3) await newTab()
  const [a, b, c] = (await read()).tabs
  assert.ok(a && b && c)
  await page.locator(`[data-tab-id="${b.id}"]`).click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    b.id,
  )
  await replaceRichText(
    page,
    page.getByRole('textbox', { name: /document editor/i }),
    'dirty b',
  )
  await page.locator(`[data-tab-id="${c.id}"]`).click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    c.id,
  )
  const openMenu = async (id) => {
    await page.locator(`[data-tab-id="${id}"]`).click({ button: 'right' })
    await page.getByRole('menu', { name: 'Tab actions' }).waitFor()
  }
  await openMenu(a.id)
  await page
    .getByRole('menuitem', { name: 'Close tabs to the right', exact: true })
    .click()
  await waitForAsync(app, () => globalThis.choices.length === 1)
  await page.waitForFunction(
    () => document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
  )
  assert.equal((await read()).tabs.length, 3)
  await app.evaluate(() => {
    globalThis.choice = 1
  })
  await openMenu(a.id)
  await page
    .getByRole('menuitem', { name: 'Close tabs to the right', exact: true })
    .click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).tabs.length === 1,
  )
  const current = await read()
  assert.deepEqual(
    current.tabs.map((tab) => tab.id),
    [a.id],
  )
  assert.equal(current.tabId, a.id)
  assert.equal(await app.evaluate(() => globalThis.choices.length), 2)
})

for (const failure of [false, true]) {
  test(`bulk close keeps saved retained tabs when a later save ${failure ? 'fails' : 'is cancelled'}`, {
    timeout: 40000,
  }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'hibi-tab-menu-partial-'))
    const files = ['a', 'b', 'c'].map((name) => join(root, `${name}.md`))
    for (const file of files)
      await writeFile(file, `original ${basename(file)}`)
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
    })
    t.after(async () => {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      await app.close()
      await rm(root, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    await waitForFormattedEditor(app, page)
    page.setDefaultTimeout(6500)
    await waitForDocumentEditor(app, page)
    const read = () => page.evaluate(() => window.hibi.getDocument())
    for (const file of files) {
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        })
      }, file)
      await clickMenu(app, 'Open…')
      await waitForAsync(
        page,
        async (name) => (await window.hibi.getDocument()).name === name,
        basename(file),
      )
    }
    const [a, b, c] = (await read()).tabs.filter((tab) =>
      ['a.md', 'b.md', 'c.md'].includes(tab.name),
    )
    assert.ok(a && b && c)
    const select = async (id) => {
      await page.locator(`[data-tab-id="${id}"]`).click()
      await waitForAsync(
        page,
        async (id) => (await window.hibi.getDocument()).tabId === id,
        id,
      )
      await waitForDocumentEditor(app, page)
    }
    const editor = page.getByRole('textbox', { name: /document editor/i })
    await select(b.id)
    await replaceRichText(page, editor, 'dirty b')
    await select(c.id)
    await replaceRichText(page, editor, 'dirty c')
    await select(a.id)
    await app.evaluate(
      ({ dialog }, { failure, file }) => {
        globalThis.choices = []
        dialog.showMessageBox = async (_window, options) => {
          globalThis.choices.push(options.message)
          return {
            response: failure || options.message.includes('b.md') ? 0 : 2,
          }
        }
        if (failure) {
          const fs = process.getBuiltinModule('node:fs/promises')
          const { syncBuiltinESMExports } =
            process.getBuiltinModule('node:module')
          const rename = fs.rename
          fs.rename = async (from, to) => {
            if (String(to) === file) {
              fs.rename = rename
              syncBuiltinESMExports()
              throw new Error('second save failed')
            }
            return rename(from, to)
          }
          syncBuiltinESMExports()
        }
      },
      { failure, file: await realpath(files[2]) },
    )
    await page.locator(`[data-tab-id="${a.id}"]`).click({ button: 'right' })
    await page
      .getByRole('menuitem', { name: 'Close other tabs', exact: true })
      .click()
    await waitForAsync(app, () => globalThis.choices.length === 2)
    await page.waitForFunction(
      () =>
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
    )
    assert.equal(await readFile(files[1], 'utf8'), 'dirty b')
    assert.equal(await readFile(files[2], 'utf8'), 'original c.md')
    const current = await read()
    assert.equal(current.tabId, a.id)
    assert.equal(current.tabs.length, 3)
    const marked = (id, description) =>
      page.waitForFunction(
        ([id, description]) =>
          document
            .querySelector(`[data-tab-id="${id}"]`)
            ?.getAttribute('aria-description') === description,
        [id, description],
      )
    // B's retained editor takes the saved baseline although C did not save.
    await marked(b.id, null)
    await marked(c.id, 'Unsaved changes')
    // Saving B activated it briefly in main; its retained editor still owns it.
    await splitTab(app, page, b.id)
    await waitForAsync(
      page,
      async (id) => (await window.hibi.getDocument()).tabId === id,
      b.id,
    )
    const right = page
      .locator('.editor-page[data-side="right"]')
      .getByRole('textbox', { name: /document editor/i })
    await right.waitFor()
    const split = await read()
    assert.equal(split.dirty, false)
    assert.equal(split.markdown, 'dirty b')
    // History keeps working against the saved text.
    await right.press('ControlOrMeta+z')
    await marked(b.id, 'Unsaved changes')
    await right.press(redoKey)
    await marked(b.id, null)
    await replaceRichText(page, right, 'dirty b again')
    await marked(b.id, 'Unsaved changes')
  })
}

test('quit and workspace deletion keep tabs saved before a later prompt cancels', {
  timeout: 60000,
}, async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-tab-quit-partial-')),
  )
  const notes = join(root, 'notes')
  await mkdir(notes)
  const [a, c, d] = [
    join(root, 'a.md'),
    join(notes, 'c.md'),
    join(notes, 'd.md'),
  ]
  for (const file of [a, c, d])
    await writeFile(file, `original ${basename(file)}`)
  const named = join(notes, 'b.md')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForFormattedEditor(app, page)
  page.setDefaultTimeout(6500)
  await waitForDocumentEditor(app, page)
  const read = () => page.evaluate(() => window.hibi.getDocument())
  const editor = page.getByRole('textbox', { name: /document editor/i })
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    })
  }, notes)
  await page.evaluate(() => window.hibi.openWorkspace())
  await waitForDocumentEditor(app, page)
  // The untitled draft comes first, so its prompt runs before the cancel.
  await replaceRichText(page, editor, 'untitled draft')
  const draftState = await read()
  const draft = draftState.tabId
  const flavor = JSON.stringify({ dialect: 'markdown', syntax: [] })
  await page.evaluate(
    ({ id, flavor }) => {
      localStorage.setItem(`hibi:flavor:${id}`, flavor)
    },
    { id: draftState.id, flavor },
  )
  for (const file of [a, c, d]) {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      basename(file),
    )
  }
  const tabs = (await read()).tabs
  const id = (name) => tabs.find((tab) => tab.name === name).id
  const select = async (tabId) => {
    await page.locator(`[data-tab-id="${tabId}"]`).click()
    await waitForAsync(
      page,
      async (id) => (await window.hibi.getDocument()).tabId === id,
      tabId,
    )
    await waitForDocumentEditor(app, page)
  }
  const marked = (tabId, description) =>
    page.waitForFunction(
      ([id, description]) =>
        document
          .querySelector(`[data-tab-id="${id}"]`)
          ?.getAttribute('aria-description') === description,
      [tabId, description],
    )
  await select(id('c.md'))
  await replaceRichText(page, editor, 'dirty c')
  await select(id('d.md'))
  await replaceRichText(page, editor, 'dirty d')
  await select(id('a.md'))
  const answer = () =>
    app.evaluate(({ dialog }, file) => {
      globalThis.choices = []
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
      // Save every prompt until D, then cancel.
      dialog.showMessageBox = async (_window, options) => {
        globalThis.choices.push(options.message)
        return {
          response: options.message === 'Save changes to d.md?' ? 2 : 0,
        }
      }
    }, named)

  await answer()
  await app.evaluate(({ app }) => app.quit())
  await waitForAsync(app, () => globalThis.choices.length === 3)
  await marked(draft, null)
  await marked(id('c.md'), null)
  await marked(id('d.md'), 'Unsaved changes')
  assert.equal(await readFile(named, 'utf8'), 'untitled draft')
  assert.equal(
    await page.evaluate(
      (id) => localStorage.getItem(`hibi:flavor:${id}`),
      createHash('sha256').update(named).digest('hex'),
    ),
    flavor,
    'prompt Save As carries the draft flavor before it is focused',
  )
  assert.equal(await readFile(c, 'utf8'), 'dirty c')
  assert.equal(await readFile(d, 'utf8'), 'original d.md')
  // Save As names the retained draft at once.
  assert.equal(
    await page.locator(`[data-tab-id="${draft}"]`).getAttribute('aria-label'),
    'b.md',
  )
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  )

  await select(id('c.md'))
  await replaceRichText(page, editor, 'dirty c again')
  await select(id('a.md'))
  await answer()
  await app.evaluate(({ shell }) => {
    globalThis.trashed = []
    shell.trashItem = async (path) => {
      globalThis.trashed.push(path)
    }
  })
  assert.equal(
    await page.evaluate(async (path) => {
      const known = await window.hibi.getKnownWorkspaces()
      const workspace = known.find((item) => item.path === path)
      return window.hibi.deleteKnownWorkspace(workspace.id)
    }, notes),
    false,
  )
  assert.equal(await app.evaluate(() => globalThis.choices.length), 2)
  await marked(id('c.md'), null)
  await marked(id('d.md'), 'Unsaved changes')
  assert.equal(await readFile(c, 'utf8'), 'dirty c again')
  assert.equal(await readFile(d, 'utf8'), 'original d.md')
  assert.deepEqual(await app.evaluate(() => globalThis.trashed), [])
})

test('middle-click closes tabs without changing the active document', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-tab-middle-click-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForFormattedEditor(app, page)
  page.setDefaultTimeout(6500)
  await waitForDocumentEditor(app, page)
  const read = () => page.evaluate(() => window.hibi.getDocument())
  const newTab = async () => {
    const before = (await read()).tabId
    await clickMenu(app, 'New')
    await waitForAsync(
      page,
      async (id) => (await window.hibi.getDocument()).tabId !== id,
      before,
    )
  }
  while ((await read()).tabs.length < 3) await newTab()
  const [a, b, c] = (await read()).tabs
  assert.ok(a && b && c)
  assert.equal((await read()).tabId, c.id)
  await page.locator(`[data-tab-id="${a.id}"]`).click({ button: 'middle' })
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).tabs.length === 2,
  )
  let current = await read()
  assert.equal(current.tabId, c.id)
  assert.equal(
    current.tabs.some((tab) => tab.id === a.id),
    false,
  )
  await page.locator(`[data-tab-id="${c.id}"]`).click({ button: 'middle' })
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).tabs.length === 1,
  )
  current = await read()
  assert.notEqual(current.tabId, c.id)
  assert.deepEqual(
    current.tabs.map((tab) => tab.id),
    [b.id],
  )
})

test('middle-click is ignored while a tab close is awaiting confirmation', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-tab-middle-busy-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        globalThis.releaseDialog?.()
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    globalThis.dialogEntered = false
    globalThis.releaseDialog = null
    dialog.showMessageBox = () =>
      new Promise((resolve) => {
        globalThis.dialogEntered = true
        globalThis.releaseDialog = () => {
          globalThis.releaseDialog = null
          resolve({ response: 2 })
        }
      })
  })
  const page = await app.firstWindow()
  await waitForFormattedEditor(app, page)
  page.setDefaultTimeout(6500)
  await waitForDocumentEditor(app, page)
  const read = () => page.evaluate(() => window.hibi.getDocument())
  const newTab = async () => {
    const before = (await read()).tabId
    await clickMenu(app, 'New')
    await waitForAsync(
      page,
      async (id) => (await window.hibi.getDocument()).tabId !== id,
      before,
    )
  }
  while ((await read()).tabs.length < 2) await newTab()
  const [a, b] = (await read()).tabs
  assert.ok(a && b)
  assert.equal((await read()).tabId, b.id)
  await page.locator(`[data-tab-id="${a.id}"]`).click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    a.id,
  )
  await replaceRichText(
    page,
    page.getByRole('textbox', { name: /document editor/i }),
    'dirty a',
  )
  await page.locator(`[data-tab-id="${b.id}"]`).click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    b.id,
  )
  await heardPrompt(page, () =>
    page.locator(`[data-tab-key="${a.id}"] .tab-close`).click(),
  )
  await waitForAsync(app, () => globalThis.dialogEntered)
  await page.locator('.app[aria-busy="true"]').waitFor()
  await page
    .locator(`[data-tab-id="${b.id}"]`)
    .click({ button: 'middle', force: true })
  await app.evaluate(() => globalThis.releaseDialog())
  await page.waitForFunction(
    () => document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
  )
  const current = await read()
  assert.equal(current.tabs.length, 2)
  assert.equal(current.tabId, b.id)
})

test('close tab pressed during a file operation runs after it, for the tab it was pressed on', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-tab-busy-close-'))
  const a = join(root, 'a.md'),
    b = join(root, 'b.md')
  await writeFile(a, 'note a')
  await writeFile(b, 'note b')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForFormattedEditor(app, page)
  page.setDefaultTimeout(6500)
  await waitForDocumentEditor(app, page)
  const read = () => page.evaluate(() => window.hibi.getDocument())
  const idle = () =>
    page.waitForFunction(
      () =>
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
    )
  for (const file of [a, b]) {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      basename(file),
    )
    await idle()
  }
  const [tabA, tabB] = (await read()).tabs
  assert.ok(tabA && tabB)
  await page.evaluate(() => {
    window.commands = 0
    window.hibi.onCommand((command) => {
      if (command === 'close-tab') window.commands++
    })
  })
  // Holds the next call on a channel in the main process until released.
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const close = handlers.get('document:close-tab')
    globalThis.closes = 0
    handlers.set('document:close-tab', (...args) => {
      globalThis.closes++
      return close(...args)
    })
    globalThis.hold = (channel) => {
      const original = handlers.get(channel)
      globalThis.held = new Promise((entered) => {
        handlers.set(channel, async (...args) => {
          handlers.set(channel, original)
          await new Promise((release) => {
            globalThis.release = release
            entered()
          })
          return original(...args)
        })
      })
    }
  })
  const closeDuring = async (start, pressed) => {
    await start()
    await app.evaluate(() => globalThis.held)
    await page.locator('.app[aria-busy="true"]').waitFor()
    await pressShortcut(
      app,
      process.platform === 'darwin' ? 'Meta+w' : 'Control+w',
    )
    await page.waitForFunction((count) => window.commands === count, pressed)
    await app.evaluate(() => globalThis.release())
  }

  // Pressed on b while a's tab was opening: b is no longer shown, so it waits for nothing.
  await closeDuring(async () => {
    await app.evaluate(() => globalThis.hold('document:select-tab'))
    await page.locator(`[data-tab-id="${tabA.id}"]`).click()
  }, 1)
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    tabA.id,
  )
  await idle()
  assert.equal((await read()).tabs.length, 2)
  assert.equal(await app.evaluate(() => globalThis.closes), 0)

  // Pressed on a while it saved: a closes once the save is done.
  await closeDuring(async () => {
    await app.evaluate(() => globalThis.hold('document:save'))
    await clickMenu(app, 'Save')
  }, 2)
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).tabs.length === 1,
  )
  await idle()
  const current = await read()
  assert.deepEqual(
    current.tabs.map((tab) => tab.id),
    [tabB.id],
  )
  assert.equal(await app.evaluate(() => globalThis.closes), 1)
  assert.equal(await readFile(a, 'utf8'), 'note a')
})

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

// Runs start, then waits until the page hears that a file prompt opened; a
// click made behind it drops there.
async function heardPrompt(page, start) {
  await page.evaluate(() => {
    window.prompted = new Promise((resolve) => {
      const stop = window.hibi.onFileDialog((open) => {
        if (!open) return
        stop()
        resolve()
      })
    })
  })
  await start()
  await page.evaluate(() => window.prompted)
}

// Opens the files in order, the last one shown. Counts the commands the page
// receives and the calls on the given channels, cancels discard prompts, and
// can hold a channel's next call.
async function launchHolding(t, prefix, files, channels, profileFiles = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  for (const [name, text] of Object.entries(profileFiles)) {
    const path = join(root, 'profile', name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
  }
  const paths = Object.fromEntries(
    Object.keys(files).map((name) => [name, join(root, name)]),
  )
  for (const [name, text] of Object.entries(files))
    await writeFile(paths[name], text)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    // Quit without saving what a test left unsaved.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const editor = await waitForFormattedEditor(app, page)
  page.setDefaultTimeout(6500)
  const idle = () =>
    page.waitForFunction(
      () =>
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
    )
  for (const file of Object.values(paths)) {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      basename(file),
    )
    await idle()
  }
  await waitForDocumentEditor(app, page)
  await page.evaluate(() => {
    window.commands = 0
    window.hibi.onCommand(() => window.commands++)
  })
  await app.evaluate(({ ipcMain, dialog }, channels) => {
    const handlers = ipcMain._invokeHandlers
    globalThis.calls = {}
    for (const channel of channels) {
      const original = handlers.get(channel)
      handlers.set(channel, (...args) => {
        globalThis.calls[channel] = (globalThis.calls[channel] ?? 0) + 1
        return original(...args)
      })
    }
    globalThis.held = {}
    globalThis.release = {}
    // Before the call runs, or after it ran and before its reply.
    globalThis.hold = (channel, after = false) => {
      const original = handlers.get(channel)
      globalThis.held[channel] = new Promise((entered) => {
        handlers.set(channel, async (...args) => {
          handlers.set(channel, original)
          const reply = after ? await original(...args) : undefined
          await new Promise((release) => {
            globalThis.release[channel] = release
            entered()
          })
          return after ? reply : original(...args)
        })
      })
    }
    globalThis.prompts = 0
    dialog.showMessageBox = async () => {
      globalThis.prompts++
      return { response: 2 }
    }
  }, channels)
  const commands = (count) =>
    page.waitForFunction((count) => window.commands === count, count)
  return { app, page, editor, paths, idle, commands }
}

test('save, close tab and save pressed during a save run in that order', {
  timeout: 30000,
}, async (t) => {
  const { app, page, editor, paths, idle, commands } = await launchHolding(
    t,
    'hibi-tab-busy-order-',
    { 'b.md': 'note b', 'a.md': 'note a' },
    [],
  )
  await app.evaluate(() => globalThis.hold('document:save', true))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  // The saved tab stays writable; this text comes after what the save wrote.
  await replaceRichText(page, editor, 'note a, more')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'note a, more',
  )
  for (const key of ['s', 'w', 's']) await pressShortcut(app, `${mod}+${key}`)
  await commands(4)
  await app.evaluate(() => globalThis.release['document:save']())
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).tabs.length === 1,
  )
  await idle()
  assert.equal(await app.evaluate(() => globalThis.prompts), 0)
  assert.equal(await readFile(paths['a.md'], 'utf8'), 'note a, more')
})

test('close tab pressed again while its prompt is open asks once', {
  timeout: 30000,
}, async (t) => {
  const { app, page, editor, idle } = await launchHolding(
    t,
    'hibi-tab-busy-prompt-',
    { 'a.md': 'note a' },
    ['document:close-tab'],
  )
  await replaceRichText(page, editor, 'note a, edited')
  await waitForAsync(page, async () => (await window.hibi.getDocument()).dirty)
  await app.evaluate(({ BrowserWindow, dialog }) => {
    // Main's own shortcut handler runs first, so a counted key was handled.
    globalThis.keys = 0
    BrowserWindow.getAllWindows()[0].webContents.on(
      'before-input-event',
      (_event, input) => {
        if (input.type === 'keyDown' && input.key.toLowerCase() === 'w')
          globalThis.keys++
      },
    )
    const cancel = dialog.showMessageBox
    dialog.showMessageBox = () => {
      dialog.showMessageBox = cancel
      globalThis.prompts++
      return new Promise((answer) => {
        globalThis.answer = () => answer({ response: 2 })
      })
    }
  })
  await pressShortcut(app, `${mod}+w`)
  await waitForAsync(app, () => globalThis.prompts === 1)
  // Again, by its shortcut and from the menu, while the prompt is open.
  await pressShortcut(app, `${mod}+w`)
  await waitForAsync(app, () => globalThis.keys === 2)
  await clickMenu(app, 'Close tab')
  await app.evaluate(() => globalThis.answer())
  await idle()
  assert.equal(await app.evaluate(() => globalThis.prompts), 1)
  assert.equal(
    await app.evaluate(() => globalThis.calls['document:close-tab']),
    1,
  )
})

test('a save pressed while a file opens leaves its tab writable', {
  timeout: 30000,
}, async (t) => {
  const { app, page, idle, commands } = await launchHolding(
    t,
    'hibi-tab-busy-writable-',
    { 'a.md': 'note a' },
    ['document:save'],
  )
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    globalThis.hold('document:open')
  })
  await clickMenu(app, 'Open…')
  await app.evaluate(() => globalThis.held['document:open'])
  await page.locator('.app[aria-busy="true"]').waitFor()
  await pressShortcut(app, `${mod}+s`)
  await commands(2)
  await app.evaluate(() => {
    globalThis.hold('document:save')
    globalThis.release['document:open']()
  })
  await app.evaluate(() => globalThis.held['document:save'])
  await page.waitForFunction(
    () =>
      document.querySelector('.app')?.getAttribute('aria-busy') === 'true' &&
      document
        .querySelector('.rich-pane .hibi-formatted .cm-content')
        ?.getAttribute('contenteditable') === 'true',
  )
  await app.evaluate(() => globalThis.release['document:save']())
  await idle()
  assert.equal(await app.evaluate(() => globalThis.calls['document:save']), 1)
})

test('a command waiting when editing pauses does not run after recovery', {
  timeout: 30000,
}, async (t) => {
  const { app, page, idle, commands } = await launchHolding(
    t,
    'hibi-tab-busy-paused-',
    { 'b.md': 'note b', 'a.md': 'note a' },
    ['document:close-tab'],
  )
  const { tabId: a, tabs } = await page.evaluate(() =>
    window.hibi.getDocument(),
  )
  const b = tabs.find((tab) => tab.id !== a).id
  // Focusing b fails, and so does going back to a: editing pauses.
  await app.evaluate(
    ({ ipcMain }, ids) => {
      const handlers = ipcMain._invokeHandlers
      const focus = handlers.get('document:focus-tab')
      let phase = 0
      handlers.set('document:focus-tab', async (...args) => {
        if (phase === 0 && args[1] === ids.b) {
          phase = 1
          await new Promise((release) => {
            globalThis.releaseFocus = release
          })
          const metadata = await focus(...args)
          return { ...metadata, contentVersion: metadata.contentVersion + 1 }
        }
        if (phase === 1 && args[1] === ids.a) {
          phase = 2
          throw new Error('Simulated focus rollback failure.')
        }
        return focus(...args)
      })
    },
    { a, b },
  )
  await splitTab(app, page, b)
  await waitForAsync(app, () => !!globalThis.releaseFocus)
  await page
    .getByRole('dialog', { name: /^command palette$/i })
    .waitFor({ state: 'hidden' })
  await pressShortcut(app, `${mod}+w`)
  // The palette came from the menu too.
  await commands(2)
  await app.evaluate(() => globalThis.releaseFocus())
  const retry = page.getByRole('button', { name: 'Retry document focus' })
  await retry.waitFor()
  // Nor does one pressed while it is paused.
  await pressShortcut(app, `${mod}+w`)
  await commands(3)
  await retry.click()
  await retry.waitFor({ state: 'hidden' })
  await idle()
  assert.equal(
    await app.evaluate(() => globalThis.calls['document:close-tab'] ?? 0),
    0,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabs.length,
    2,
  )
})

test('a tab click and a tab close made during a save run after it', {
  timeout: 30000,
}, async (t) => {
  const { app, page, idle } = await launchHolding(
    t,
    'hibi-tab-busy-click-',
    { 'c.md': 'note c', 'b.md': 'note b', 'a.md': 'note a' },
    ['document:close-tabs'],
  )
  const [c, b, a] = (await page.evaluate(() => window.hibi.getDocument())).tabs
  assert.ok(a && b && c)
  await app.evaluate(() => globalThis.hold('document:save'))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  // The strip shows the operation, and its tabs still take clicks.
  await page.locator('.document-tabs[aria-busy="true"]').waitFor()
  await page.locator(`[data-tab-key="${c.id}"] .tab-close`).click()
  await page.locator(`[data-tab-id="${b.id}"]`).click()
  await app.evaluate(() => globalThis.release['document:save']())
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    b.id,
  )
  await idle()
  assert.deepEqual(
    (await page.evaluate(() => window.hibi.getDocument())).tabs.map(
      (tab) => tab.id,
    ),
    [b.id, a.id],
  )
  assert.equal(
    await app.evaluate(() => globalThis.calls['document:close-tabs']),
    1,
  )
})

test('tab clicks made behind a close prompt drop', {
  timeout: 30000,
}, async (t) => {
  const { app, page, editor, idle } = await launchHolding(
    t,
    'hibi-tab-busy-click-prompt-',
    { 'b.md': 'note b', 'a.md': 'note a' },
    ['document:close-tab', 'document:select-tab', 'document:close-tabs'],
  )
  const [b, a] = (await page.evaluate(() => window.hibi.getDocument())).tabs
  assert.ok(a && b)
  await replaceRichText(page, editor, 'note a, edited')
  await waitForAsync(page, async () => (await window.hibi.getDocument()).dirty)
  await app.evaluate(({ dialog }) => {
    const cancel = dialog.showMessageBox
    dialog.showMessageBox = () => {
      dialog.showMessageBox = cancel
      globalThis.prompts++
      return new Promise((answer) => {
        globalThis.answer = () => answer({ response: 2 })
      })
    }
  })
  await heardPrompt(page, () => pressShortcut(app, `${mod}+w`))
  await waitForAsync(app, () => globalThis.prompts === 1)
  await page.locator(`[data-tab-id="${b.id}"]`).click()
  await page.locator(`[data-tab-key="${b.id}"] .tab-close`).click()
  await app.evaluate(() => globalThis.answer())
  await idle()
  const current = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(current.tabId, a.id)
  assert.equal(current.tabs.length, 2)
  assert.equal(
    await app.evaluate(() => globalThis.calls['document:close-tab']),
    1,
  )
  assert.equal(
    await app.evaluate(() => globalThis.calls['document:select-tab'] ?? 0),
    0,
  )
  assert.equal(
    await app.evaluate(() => globalThis.calls['document:close-tabs'] ?? 0),
    0,
  )
})

test('new note pressed twice during a save opens two', {
  timeout: 30000,
}, async (t) => {
  const { app, page, idle, commands } = await launchHolding(
    t,
    'hibi-tab-busy-new-',
    { 'a.md': 'note a' },
    [],
  )
  await app.evaluate(() => globalThis.hold('document:save'))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  await pressShortcut(app, `${mod}+n`)
  await pressShortcut(app, `${mod}+n`)
  await commands(3)
  await app.evaluate(() => globalThis.release['document:save']())
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).tabs.length === 3,
  )
  await idle()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabs.length,
    3,
  )
})

test('a file opened from outside during a save opens when it ends', {
  timeout: 30000,
}, async (t) => {
  const { app, page, paths, idle } = await launchHolding(
    t,
    'hibi-tab-busy-external-',
    { 'a.md': 'note a' },
    [],
  )
  const b = join(dirname(paths['a.md']), 'b.md')
  await writeFile(b, 'note b')
  await app.evaluate(() => globalThis.hold('document:save'))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  await page.evaluate(() => {
    window.heard = new Promise((resolve) => {
      const stop = window.hibi.onExternalDocuments(() => {
        stop()
        resolve()
      })
    })
  })
  await app.evaluate(
    ({ app }, path) => app.emit('open-file', { preventDefault() {} }, path),
    b,
  )
  // The request reached the page while the save was still running.
  await page.evaluate(() => window.heard)
  await app.evaluate(() => globalThis.release['document:save']())
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'b.md',
  )
  await idle()
})

const tabFixtureDir = 'installed-addons/tab-fixture'
// An addon with one tab view, opened by window.tabFixture.open().
const tabFixture = {
  'addons.json': JSON.stringify({ 'tab-fixture': true }),
  [`${tabFixtureDir}/hibi-addon.json`]: JSON.stringify({
    id: 'tab-fixture',
    name: 'Tab fixture',
    description: 'Tab fixture',
    kind: 'extension',
    authors: [{ displayName: 'Test' }],
    apiVersion: 3,
    version: '1.0.0',
    capabilities: ['ui'],
    entry: 'index.js',
  }),
  [`${tabFixtureDir}/.hibi-install.json`]: JSON.stringify({
    hash: 'a'.repeat(64),
    files: ['index.js', 'hibi-addon.json'],
    source: 'local',
  }),
  [`${tabFixtureDir}/index.js`]: `export default ({ React }) => ({ start(context) {
      window.tabFixture = context.views.register({ id: 'tab', label: 'Fixture tab', location: 'tab', lifetime: 'session', Content() { return React.createElement('p', null, 'fixture') } });
    }});`,
}

test('close tab pressed on a note drops when an addon tab is shown by the time it runs', {
  timeout: 30000,
}, async (t) => {
  const { app, page, idle, commands } = await launchHolding(
    t,
    'hibi-tab-busy-addon-',
    { 'a.md': 'note a' },
    ['document:close-tab'],
    tabFixture,
  )
  await page.waitForFunction(() => window.tabFixture)
  await app.evaluate(() => globalThis.hold('document:save'))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  await pressShortcut(app, `${mod}+w`)
  await commands(2)
  // The addon tab is shown before the save ends; the press was for the note.
  await page.evaluate(() => window.tabFixture.open({ id: 'one' }))
  const addonTab = page.getByRole('tab', {
    name: 'Fixture tab',
    selected: true,
  })
  await addonTab.waitFor()
  await app.evaluate(() => globalThis.release['document:save']())
  await idle()
  assert.equal(await addonTab.count(), 1)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabs.length,
    1,
  )
  assert.equal(
    await app.evaluate(() => globalThis.calls['document:close-tab'] ?? 0),
    0,
  )
})

// An addon that hands its editor.runCommand to the page, as the Vim addon's
// u, Ctrl+R and :w call it.
const runFixture = {
  'addons.json': JSON.stringify({ 'run-fixture': true }),
  'installed-addons/run-fixture/hibi-addon.json': JSON.stringify({
    id: 'run-fixture',
    name: 'Run fixture',
    description: 'Run fixture',
    kind: 'extension',
    authors: [{ displayName: 'Test' }],
    apiVersion: 3,
    version: '1.0.0',
    capabilities: ['ui'],
    entry: 'index.js',
  }),
  'installed-addons/run-fixture/.hibi-install.json': JSON.stringify({
    hash: 'a'.repeat(64),
    files: ['index.js', 'hibi-addon.json'],
    source: 'local',
  }),
  'installed-addons/run-fixture/index.js': `export default () => ({ start(context) {
    window.fixtureRun = (command) => context.editor.runCommand(command)
  }});`,
}

// Waits until the page has heard a file opened from outside.
async function openFromOutside(app, page, path) {
  await page.evaluate(() => {
    window.heard = new Promise((resolve) => {
      const stop = window.hibi.onExternalDocuments(() => {
        stop()
        resolve()
      })
    })
  })
  await app.evaluate(
    ({ app }, path) => app.emit('open-file', { preventDefault() {} }, path),
    path,
  )
  await page.evaluate(() => window.heard)
}

test('an addon undo asked during a save drops instead of undoing the note a waiting click shows', {
  timeout: 45000,
}, async (t) => {
  const { app, page, editor, idle } = await launchHolding(
    t,
    'hibi-tab-busy-undo-tab-',
    { 'b.md': 'note b', 'a.md': 'note a' },
    [],
    runFixture,
  )
  await page.waitForFunction(() => window.fixtureRun)
  const [b, a] = (await page.evaluate(() => window.hibi.getDocument())).tabs
  assert.ok(a && b)
  const show = async (id) => {
    await page.locator(`[data-tab-id="${id}"]`).click()
    await waitForAsync(
      page,
      async (id) => (await window.hibi.getDocument()).tabId === id,
      id,
    )
    await idle()
    await waitForDocumentEditor(app, page)
  }
  await show(b.id)
  await replaceRichText(page, editor, 'note b, edited')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'note b, edited',
  )
  await show(a.id)
  await app.evaluate(() => globalThis.hold('document:save'))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  // A click on b waits; the addon asks for undo while a is still shown.
  await page.locator(`[data-tab-id="${b.id}"]`).click()
  await page.evaluate(() => {
    window.undone = window.fixtureRun('undo')
  })
  await app.evaluate(() => globalThis.release['document:save']())
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    b.id,
  )
  assert.equal(await page.evaluate(() => window.undone), false)
  await idle()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'note b, edited',
  )
})

test('an addon undo asked during a save does not take back text typed after it', {
  timeout: 45000,
}, async (t) => {
  const { app, page, editor, idle } = await launchHolding(
    t,
    'hibi-tab-busy-undo-later-',
    { 'a.md': 'note a' },
    [],
    runFixture,
  )
  await page.waitForFunction(() => window.fixtureRun)
  await replaceRichText(page, editor, 'note a, edited')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'note a, edited',
  )
  await app.evaluate(() => globalThis.hold('document:save'))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  await page.evaluate(() => {
    window.undone = window.fixtureRun('undo')
  })
  // The saved tab stays writable.
  await replaceRichText(page, editor, 'note a, edited, more')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'note a, edited, more',
  )
  await app.evaluate(() => globalThis.release['document:save']())
  assert.equal(await page.evaluate(() => window.undone), false)
  await idle()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'note a, edited, more',
  )
})

test('an addon save asked during a tab switch drops once another tab is shown', {
  timeout: 45000,
}, async (t) => {
  const { app, page, editor, idle } = await launchHolding(
    t,
    'hibi-tab-busy-addon-save-',
    { 'b.md': 'note b', 'a.md': 'note a' },
    ['document:save'],
    runFixture,
  )
  await page.waitForFunction(() => window.fixtureRun)
  const [b, a] = (await page.evaluate(() => window.hibi.getDocument())).tabs
  assert.ok(a && b)
  await replaceRichText(page, editor, 'note a, edited')
  await waitForAsync(page, async () => (await window.hibi.getDocument()).dirty)
  await app.evaluate(() => globalThis.hold('document:select-tab'))
  await page.locator(`[data-tab-id="${b.id}"]`).click()
  await app.evaluate(() => globalThis.held['document:select-tab'])
  // Asked while a is shown: it is a's save, not b's.
  await page.evaluate(() => {
    window.saved = window.fixtureRun('save')
  })
  await app.evaluate(() => globalThis.release['document:select-tab']())
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    b.id,
  )
  assert.equal(await page.evaluate(() => window.saved), false)
  await idle()
  assert.equal(
    await app.evaluate(() => globalThis.calls['document:save'] ?? 0),
    0,
  )
})

test('a dialog answered while a file opened from outside waits runs its own action first', {
  timeout: 45000,
}, async (t) => {
  const { app, page, paths, idle } = await launchHolding(
    t,
    'hibi-tab-busy-dialog-external-',
    { 'a.md': 'note a' },
    ['document:remote'],
  )
  const b = join(dirname(paths['a.md']), 'b.md')
  await writeFile(b, 'note b')
  await clickMenu(app, 'Open from URL…')
  const prompt = page.getByRole('dialog', { name: 'Open from URL' })
  await prompt.waitFor()
  await openFromOutside(app, page, b)
  // A closed local port fails at once; only the call matters.
  await prompt.getByRole('textbox').fill('http://127.0.0.1:9/x.md')
  await prompt.getByRole('button', { name: 'Open' }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'b.md',
  )
  await idle()
  assert.equal(
    await app.evaluate(() => globalThis.calls['document:remote'] ?? 0),
    1,
  )
})

test('a save pressed during a save goes before a file opened from outside meanwhile', {
  timeout: 45000,
}, async (t) => {
  const { app, page, editor, paths, idle, commands } = await launchHolding(
    t,
    'hibi-tab-busy-save-external-',
    { 'a.md': 'note a' },
    [],
  )
  const b = join(dirname(paths['a.md']), 'b.md')
  await writeFile(b, 'note b')
  // Main writes "note a", then holds its reply.
  await app.evaluate(() => globalThis.hold('document:save', true))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  await replaceRichText(page, editor, 'note a, more')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'note a, more',
  )
  await pressShortcut(app, `${mod}+s`)
  await commands(2)
  await openFromOutside(app, page, b)
  await app.evaluate(() => globalThis.release['document:save']())
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'b.md',
  )
  await idle()
  assert.equal(await readFile(paths['a.md'], 'utf8'), 'note a, more')
})

test('arrow keys on the tabs during a save choose a tab that opens after it, and say so', {
  timeout: 30000,
}, async (t) => {
  const { app, page, idle } = await launchHolding(
    t,
    'hibi-tab-busy-keys-',
    { 'c.md': 'note c', 'b.md': 'note b', 'a.md': 'note a' },
    [],
  )
  const [c, b, a] = (await page.evaluate(() => window.hibi.getDocument())).tabs
  assert.ok(a && b && c)
  await page.locator(`[data-tab-id="${a.id}"]`).focus()
  await app.evaluate(() => globalThis.hold('document:save'))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  await page.locator('.document-tabs[aria-busy="true"]').waitFor()
  assert.equal(
    await page
      .locator(`[data-tab-id="${b.id}"]`)
      .getAttribute('aria-description'),
    'Opens when the current file operation ends',
  )
  // Focus moves at once; the last tab chosen opens when the save ends.
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.locator(`[data-tab-id="${c.id}"]:focus`).waitFor()
  await app.evaluate(() => globalThis.release['document:save']())
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    c.id,
  )
  await idle()
  assert.equal(
    await page
      .locator(`[data-tab-id="${b.id}"]`)
      .getAttribute('aria-description'),
    null,
  )
})

test('an addon tab clicked during a save shows when it ends', {
  timeout: 30000,
}, async (t) => {
  const { app, page, idle } = await launchHolding(
    t,
    'hibi-tab-busy-addon-click-',
    { 'a.md': 'note a' },
    [],
    tabFixture,
  )
  await page.waitForFunction(() => window.tabFixture)
  await page.evaluate(() => window.tabFixture.open({ id: 'one' }))
  const addonTab = page.getByRole('tab', { name: 'Fixture tab' })
  await page.getByRole('tab', { name: 'a.md' }).click()
  await page.getByRole('tab', { name: 'a.md', selected: true }).waitFor()
  await idle()
  await app.evaluate(() => globalThis.hold('document:save'))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  // Main has the save before the window has drawn itself busy.
  await page.locator('.app[aria-busy="true"]').waitFor()
  assert.equal(
    await addonTab.getAttribute('aria-description'),
    'Opens when the current file operation ends',
  )
  await addonTab.click()
  assert.equal(await addonTab.getAttribute('aria-selected'), 'false')
  await app.evaluate(() => globalThis.release['document:save']())
  await page.getByRole('tab', { name: 'Fixture tab', selected: true }).waitFor()
  await idle()
  assert.equal(await addonTab.getAttribute('aria-selected'), 'true')
})

test('a click back on the shown tab during a save takes the place of a waiting click', {
  timeout: 30000,
}, async (t) => {
  const { app, page, idle } = await launchHolding(
    t,
    'hibi-tab-busy-click-back-',
    { 'b.md': 'note b', 'a.md': 'note a' },
    [],
  )
  const [b, a] = (await page.evaluate(() => window.hibi.getDocument())).tabs
  assert.ok(a && b)
  await app.evaluate(() => globalThis.hold('document:save'))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  await page.locator(`[data-tab-id="${b.id}"]`).click()
  await page.locator(`[data-tab-id="${a.id}"]`).click()
  await app.evaluate(() => globalThis.release['document:save']())
  await idle()
  // Anything still queued has run by the time the next operation is answered.
  await clickMenu(app, 'Save')
  await idle()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabId,
    a.id,
  )
})

test('tab moves by key during a save each run after it and the tab keeps focus', {
  timeout: 45000,
}, async (t) => {
  const { app, page, idle } = await launchHolding(
    t,
    'hibi-tab-busy-move-keys-',
    { 'c.md': 'note c', 'b.md': 'note b', 'a.md': 'note a' },
    ['document:move-tab'],
  )
  const [c, b, a] = (await page.evaluate(() => window.hibi.getDocument())).tabs
  assert.ok(a && b && c)
  const order = async () =>
    (await page.evaluate(() => window.hibi.getDocument())).tabs.map(
      (tab) => tab.id,
    )
  const moves = (count) =>
    waitForAsync(
      app,
      (_, count) => globalThis.calls['document:move-tab'] === count,
      count,
    )
  const holdSave = async () => {
    await app.evaluate(() => globalThis.hold('document:save'))
    await clickMenu(app, 'Save')
    await app.evaluate(() => globalThis.held['document:save'])
  }
  const release = () =>
    app.evaluate(() => globalThis.release['document:save']())
  // Moving right makes React move the focused tab's own node.
  await page.locator(`[data-tab-id="${c.id}"]`).focus()
  await holdSave()
  await page.keyboard.press('Alt+Shift+ArrowRight')
  await page.keyboard.press('Alt+Shift+ArrowRight')
  assert.deepEqual(await order(), [c.id, b.id, a.id])
  await release()
  await moves(2)
  await idle()
  assert.deepEqual(await order(), [b.id, a.id, c.id])
  await page.locator(`[data-tab-id="${c.id}"]:focus`).waitFor()
  // Shown last, it can still go left and then right again.
  await holdSave()
  await page.keyboard.press('Alt+Shift+ArrowLeft')
  await page.keyboard.press('Alt+Shift+ArrowRight')
  await release()
  await moves(4)
  await idle()
  assert.deepEqual(await order(), [b.id, a.id, c.id])
  // Focus the user moved elsewhere stays there when the move runs.
  await page.locator(`[data-tab-id="${c.id}"]`).focus()
  await holdSave()
  await page.keyboard.press('Alt+Shift+ArrowLeft')
  await page.locator(`[data-tab-id="${a.id}"]`).click()
  await release()
  await moves(5)
  await idle()
  assert.deepEqual(await order(), [b.id, c.id, a.id])
  await page.locator(`[data-tab-id="${a.id}"]:focus`).waitFor()
})

test('a tab dragged during a save moves after it, unless the tab it went before closed', {
  timeout: 30000,
}, async (t) => {
  const { app, page, idle } = await launchHolding(
    t,
    'hibi-tab-busy-move-drag-',
    { 'c.md': 'note c', 'b.md': 'note b', 'a.md': 'note a' },
    [],
  )
  const [c, b, a] = (await page.evaluate(() => window.hibi.getDocument())).tabs
  assert.ok(a && b && c)
  const order = async () =>
    (await page.evaluate(() => window.hibi.getDocument())).tabs.map(
      (tab) => tab.id,
    )
  const settled = () =>
    page
      .locator('.document-tabs')
      .evaluate((strip) =>
        Promise.all(
          strip
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished),
        ),
      )
  const drag = (id, before) =>
    page
      .locator(`[data-tab-key="${id}"]`)
      .dragTo(page.locator(`[data-tab-key="${before}"]`), {
        targetPosition: { x: 8, y: 10 },
      })
  const holdSave = async () => {
    await app.evaluate(() => globalThis.hold('document:save'))
    await clickMenu(app, 'Save')
    await app.evaluate(() => globalThis.held['document:save'])
  }
  await settled()
  await holdSave()
  await drag(a.id, b.id)
  assert.deepEqual(await order(), [c.id, b.id, a.id])
  await app.evaluate(() => globalThis.release['document:save']())
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabs[1].id === id,
    a.id,
  )
  await idle()
  assert.deepEqual(await order(), [c.id, a.id, b.id])
  await settled()
  // The close waits first and runs first; the move then has nothing to go before.
  await holdSave()
  await page.getByRole('button', { name: 'Close c.md' }).click()
  await drag(b.id, c.id)
  await app.evaluate(() => globalThis.release['document:save']())
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).tabs.length === 2,
  )
  await idle()
  assert.deepEqual(await order(), [a.id, b.id])
  assert.equal(await page.getByText('This tab is no longer open.').count(), 0)
})

test('tabs promise nothing and take no keys while editing is paused', {
  timeout: 45000,
}, async (t) => {
  const { app, page, idle } = await launchHolding(
    t,
    'hibi-tab-paused-',
    { 'c.md': 'note c', 'b.md': 'note b', 'a.md': 'note a' },
    [],
  )
  const { tabId: a, tabs } = await page.evaluate(() =>
    window.hibi.getDocument(),
  )
  const b = tabs.find((tab) => tab.name === 'b.md').id
  const c = tabs.find((tab) => tab.name === 'c.md').id
  await splitTab(app, page, b)
  await page.getByRole('button', { name: 'Close split' }).waitFor()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    b,
  )
  await idle()
  // Going to the left pane's note fails, and so does going back.
  await app.evaluate(
    ({ ipcMain }, ids) => {
      const handlers = ipcMain._invokeHandlers
      const focus = handlers.get('document:focus-tab')
      let phase = 0
      handlers.set('document:focus-tab', async (...args) => {
        if (phase === 0 && args[1] === ids.a) {
          phase = 1
          const metadata = await focus(...args)
          return { ...metadata, contentVersion: metadata.contentVersion + 1 }
        }
        if (phase === 1 && args[1] === ids.b) {
          phase = 2
          throw new Error('Simulated focus rollback failure.')
        }
        globalThis.focusedAfter = (globalThis.focusedAfter ?? 0) + 1
        return focus(...args)
      })
    },
    { a, b },
  )
  await page.locator(`[data-tab-id="${a}"]`).click()
  const retry = page.getByRole('button', { name: 'Retry document focus' })
  await retry.waitFor()
  const other = page.locator(`[data-tab-id="${c}"]`)
  assert.equal(await other.getAttribute('aria-description'), null)
  assert.equal(
    await page.locator(`[data-tab-key="${c}"]`).getAttribute('draggable'),
    'false',
  )
  // Main is on the note going back failed from; the strip shows the other.
  const shown = await page
    .locator('.document-tabs [role="tab"][aria-selected="true"]')
    .getAttribute('data-tab-id')
  // An arrow key from beside the shown tab neither moves focus nor retries.
  const beside = tabs[tabs.findIndex((tab) => tab.id === shown) + 1] ?? tabs[0]
  const focused = page.locator(`[data-tab-id="${beside.id}"]`)
  await focused.focus()
  await page.keyboard.press('ArrowLeft')
  await page.locator(`[data-tab-id="${beside.id}"]:focus`).waitFor()
  // Nor does a click on the shown tab retry; only the notice's button does.
  await page.locator(`[data-tab-id="${shown}"]`).click()
  // Its call would reach main before this one.
  await page.evaluate(() => window.hibi.getDocument())
  assert.equal(await app.evaluate(() => globalThis.focusedAfter ?? 0), 0)
  assert.equal(await retry.isVisible(), true)
})

test('an addon asking for two new notes during a save gets both', {
  timeout: 45000,
}, async (t) => {
  const { app, page, idle } = await launchHolding(
    t,
    'hibi-tab-busy-addon-new-',
    { 'a.md': 'note a' },
    [],
    runFixture,
  )
  await page.waitForFunction(() => window.fixtureRun)
  await app.evaluate(() => globalThis.hold('document:save'))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  await page.evaluate(() => {
    window.created = Promise.all([
      window.fixtureRun('new'),
      window.fixtureRun('new'),
    ])
  })
  await app.evaluate(() => globalThis.release['document:save']())
  assert.deepEqual(await page.evaluate(() => window.created), [true, true])
  await idle()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabs.length,
    3,
  )
})

test('an addon save asked while a waiting save as has its dialog open saves after it', {
  timeout: 45000,
}, async (t) => {
  const { app, page, paths, idle, commands } = await launchHolding(
    t,
    'hibi-tab-busy-addon-save-as-',
    { 'a.md': 'note a' },
    ['document:save'],
    runFixture,
  )
  await page.waitForFunction(() => window.fixtureRun)
  const copy = join(dirname(paths['a.md']), 'copy.md')
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = () =>
      new Promise((answer) => {
        globalThis.answerSaveAs = answer
      })
    globalThis.hold('document:save')
  })
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  await pressShortcut(app, `${mod}+Shift+s`)
  await commands(2)
  // The save ends; the waiting save as starts in its place and opens its dialog.
  await heardPrompt(page, () =>
    app.evaluate(() => globalThis.release['document:save']()),
  )
  await page.evaluate(() => {
    window.saved = window.fixtureRun('save')
  })
  await app.evaluate(
    (_, filePath) => globalThis.answerSaveAs({ canceled: false, filePath }),
    copy,
  )
  assert.equal(await page.evaluate(() => window.saved), true)
  await idle()
  assert.equal(await readFile(copy, 'utf8'), 'note a')
})

test('a link followed during a save opens when it ends', {
  timeout: 30000,
}, async (t) => {
  const { app, page, idle } = await launchHolding(
    t,
    'hibi-tab-busy-link-',
    { 'b.md': 'note b', 'a.md': 'see [the other](b.md)' },
    [],
  )
  const link = page
    .locator('.rich-pane')
    .getByRole('link', { name: 'the other', exact: true })
  await link.waitFor()
  await app.evaluate(() => globalThis.hold('document:save'))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  await link.click({ modifiers: ['Shift'] })
  await app.evaluate(() => globalThis.release['document:save']())
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'b.md',
  )
  await idle()
})

async function mediaDrop(t, prefix, note = 'note a') {
  const launched = await launchHolding(t, prefix, { 'a.md': note }, [])
  const { page, editor, paths } = launched
  const gif = join(dirname(paths['a.md']), 'dot.gif')
  await writeFile(
    gif,
    Buffer.from(
      'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      'base64',
    ),
  )
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'fixture-file'
    input.hidden = true
    document.body.append(input)
  })
  const drop = async (at) => {
    await page.locator('#fixture-file').setInputFiles(gif)
    const transfer = await page
      .locator('#fixture-file')
      .evaluateHandle((input) => {
        const data = new DataTransfer()
        for (const file of input.files) data.items.add(file)
        return data
      })
    await editor.dispatchEvent('drop', {
      dataTransfer: transfer,
      clientX: at?.x,
      clientY: at?.y,
    })
    await transfer.dispose()
  }
  const notice = page.getByText(
    /The note changed before the files could be inserted/,
  )
  const links = (count) =>
    waitForAsync(
      page,
      async (count) =>
        (await window.hibi.getDocument()).markdown.match(/assets\/dot/g)
          ?.length === count,
      count,
    )
  const assets = join(dirname(paths['a.md']), 'assets')
  const markdown = async () =>
    (await page.evaluate(() => window.hibi.getDocument())).markdown
  const scrollTo = async (text) => {
    await editor.evaluate((element, text) => {
      const { view } = element.cmTile.root
      view.dispatch({
        effects: view.constructor.scrollIntoView(
          view.state.doc.toString().indexOf(text),
          { y: 'center' },
        ),
      })
    }, text)
    await page.evaluate(() => new Promise(requestAnimationFrame))
  }
  // On screen just after 'line' in the given line.
  const place = (text) =>
    editor.evaluate((element, text) => {
      const { view } = element.cmTile.root
      const box = view.coordsAtPos(view.state.doc.toString().indexOf(text) + 4)
      return { x: box.left + 1, y: (box.top + box.bottom) / 2 }
    }, text)
  return { ...launched, drop, notice, links, assets, markdown, scrollTo, place }
}

const manyLines = Array.from({ length: 120 }, (_, line) => `line ${line}`).join(
  '\n\n',
)
const holdSave = async (app) => {
  await app.evaluate(() => globalThis.hold('document:save'))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
}

test('media drops during a save all go in the note when it ends, with typing behind them', {
  timeout: 45000,
}, async (t) => {
  const { app, page, editor, drop, notice, assets, idle, links } =
    await mediaDrop(t, 'hibi-tab-busy-drops-')
  await app.evaluate(() => globalThis.hold('document:save'))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  // The saved tab stays writable, so drops into it wait for the save.
  await drop()
  await drop()
  await editor.evaluate((element) => {
    element.cmTile.root.view.dispatch({ changes: { from: 0, insert: 'x' } })
  })
  await app.evaluate(() => globalThis.release['document:save']())
  await links(2)
  await idle()
  assert.deepEqual((await readdir(assets)).sort(), ['dot-2.gif', 'dot.gif'])
  assert.equal(await notice.count(), 0)
  assert.match(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    /x/,
  )
})

test('a media drop goes in the note before the next one starts', {
  timeout: 45000,
}, async (t) => {
  const { app, drop, notice, links } = await mediaDrop(t, 'hibi-tab-next-drop-')
  // Both drops are in when the first one's files come back, and the next one's
  // take their time: the one before doesn't wait for them.
  await app.evaluate(({ ipcMain }, channel) => {
    const attach = ipcMain._invokeHandlers.get(channel)
    const replies = [
      new Promise((resolve) => {
        globalThis.releaseFirst = resolve
      }),
      new Promise((resolve) => {
        globalThis.releaseSecond = resolve
      }),
    ]
    let calls = 0
    ipcMain._invokeHandlers.set(channel, async (...args) => {
      const reply = replies[calls++]
      const result = await attach(...args)
      await reply
      return result
    })
  }, MEDIA_CHANNELS.attach)
  await drop()
  await drop()
  await app.evaluate(() => globalThis.releaseFirst())
  await links(1)
  await app.evaluate(() => globalThis.releaseSecond())
  await links(2)
  assert.equal(await notice.count(), 0)
})

test('waiting media drops go where they were dropped, past a scroll and text above', {
  timeout: 45000,
}, async (t) => {
  const { app, editor, drop, notice, links, markdown, scrollTo, place } =
    await mediaDrop(t, 'hibi-tab-drop-scrolled-', manyLines)
  await scrollTo('line 60')
  const at = await place('line 60')
  await holdSave(app)
  await drop(at)
  await drop(at)
  await scrollTo('line 0')
  await editor.evaluate((element) => {
    element.cmTile.root.view.dispatch({ changes: { from: 0, insert: 'x\n\n' } })
  })
  await app.evaluate(() => globalThis.release['document:save']())
  await links(2)
  const text = await markdown()
  assert.ok(text.startsWith('x\n\nline 0'))
  assert.ok(
    text.includes('line![dot](assets/dot.gif)![dot](assets/dot-2.gif) 60'),
    text.slice(0, 600),
  )
  assert.equal(await notice.count(), 0)
})

test('a waiting media drop keeps its place above another, with a notice once text goes in on both sides', {
  timeout: 45000,
}, async (t) => {
  const { app, editor, drop, notice, links, markdown, place, idle } =
    await mediaDrop(t, 'hibi-tab-drop-above-', manyLines)
  const [lower, upper] = [await place('line 5'), await place('line 2')]
  await holdSave(app)
  await drop(lower)
  await drop(upper)
  await app.evaluate(() => globalThis.release['document:save']())
  await links(2)
  const text = await markdown()
  assert.ok(text.includes('line![dot](assets/dot.gif) 5'), text.slice(0, 300))
  assert.ok(text.includes('line![dot](assets/dot-2.gif) 2'), text.slice(0, 300))
  assert.equal(await notice.count(), 0)
  await idle()
  const [below, above] = [await place('line 7'), await place('line 6')]
  await holdSave(app)
  await drop(below)
  await drop(above)
  await editor.evaluate((element) => {
    element.cmTile.root.view.dispatch({ changes: { from: 0, insert: 'x\n\n' } })
  })
  await app.evaluate(() => globalThis.release['document:save']())
  // The second's place has the first's link below it and that text above.
  await notice.waitFor()
  await links(3)
  const after = await markdown()
  assert.ok(
    after.includes('line![dot](assets/dot-3.gif) 7'),
    after.slice(0, 300),
  )
  assert.ok(after.includes('line 6'), after.slice(0, 300))
})

test('a media drop in the frame before an insert waits for that insert', {
  timeout: 45000,
}, async (t) => {
  const { app, page, drop, notice, links, idle } = await mediaDrop(
    t,
    'hibi-tab-frame-drop-',
  )
  await page.evaluate(() => {
    const frame = window.requestAnimationFrame
    const held = []
    window.requestAnimationFrame = (run) => held.push(run)
    window.freeFrames = () => {
      window.requestAnimationFrame = frame
      for (const run of held) frame(run)
    }
  })
  await app.evaluate(
    (_, channel) => globalThis.hold(channel, true),
    MEDIA_CHANNELS.attach,
  )
  await drop()
  await app.evaluate(
    (_, channel) => globalThis.held[channel],
    MEDIA_CHANNELS.attach,
  )
  await page.waitForFunction(
    () => document.querySelector('.app').getAttribute('aria-busy') === 'true',
  )
  await app.evaluate(
    (_, channel) => globalThis.release[channel](),
    MEDIA_CHANNELS.attach,
  )
  // Writable again, and the first drop's insert is waiting for its frame.
  await idle()
  await drop()
  await page.evaluate(() => window.freeFrames())
  await links(2)
  assert.equal(await notice.count(), 0)
})

test('a media drop whose files come back after an edit has the same notice', {
  timeout: 45000,
}, async (t) => {
  const { app, page, editor, drop, notice, assets } = await mediaDrop(
    t,
    'hibi-tab-late-drop-',
  )
  // Another drop's text lands as the files are saved.
  await app.evaluate(({ ipcMain }, channel) => {
    const attach = ipcMain._invokeHandlers.get(channel)
    const late = new Promise((resolve) => {
      globalThis.releaseAttach = resolve
    })
    globalThis.attached = new Promise((resolve) => {
      ipcMain._invokeHandlers.set(channel, async (...args) => {
        const result = await attach(...args)
        resolve()
        await late
        return result
      })
    })
  }, MEDIA_CHANNELS.attach)
  await drop()
  await app.evaluate(() => globalThis.attached)
  await editor.evaluate((element) => {
    element.cmTile.root.view.dispatch({ changes: { from: 0, insert: 'x' } })
  })
  await page.evaluate(() => window.hibi.flushDocumentChanges())
  await app.evaluate(() => globalThis.releaseAttach())
  await notice.waitFor()
  assert.deepEqual(await readdir(assets), ['dot.gif'])
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'xnote a',
  )
})

test('the image button pressed twice during a save opens one picker', {
  timeout: 30000,
}, async (t) => {
  const { app, page, idle } = await launchHolding(
    t,
    'hibi-tab-busy-picker-',
    { 'a.md': 'note a' },
    [],
  )
  await app.evaluate(({ dialog }) => {
    globalThis.pickers = 0
    dialog.showOpenDialog = async () => {
      globalThis.pickers++
      return { canceled: true, filePaths: [] }
    }
  })
  const image = page.getByRole('button', { name: 'Image', exact: true })
  await image.waitFor()
  await app.evaluate(() => globalThis.hold('document:save'))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  await image.click()
  await image.click()
  await app.evaluate(() => globalThis.release['document:save']())
  await waitForAsync(app, () => globalThis.pickers >= 1)
  await idle()
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => setTimeout(done))),
  )
  await idle()
  assert.equal(await app.evaluate(() => globalThis.pickers), 1)
})

test('close split clicked during a save closes it when the save ends', {
  timeout: 30000,
}, async (t) => {
  const { app, page, idle } = await launchHolding(
    t,
    'hibi-tab-busy-close-split-',
    { 'b.md': 'note b', 'a.md': 'note a' },
    ['document:focus-tab'],
  )
  const { tabId: a, tabs } = await page.evaluate(() =>
    window.hibi.getDocument(),
  )
  const b = tabs.find((tab) => tab.id !== a).id
  await splitTab(app, page, b)
  const closeSplit = page.getByRole('button', { name: 'Close split' })
  await closeSplit.waitFor()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    b,
  )
  await idle()
  const focused = () =>
    app.evaluate(() => globalThis.calls['document:focus-tab'] ?? 0)
  const before = await focused()
  await app.evaluate(() => globalThis.hold('document:save'))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  await closeSplit.click()
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => setTimeout(done))),
  )
  // Nothing moves to the left pane's note while the right one saves.
  assert.equal(await focused(), before)
  assert.equal(await closeSplit.isVisible(), true)
  await app.evaluate(() => globalThis.release['document:save']())
  await closeSplit.waitFor({ state: 'hidden' })
  await idle()
  assert.equal((await page.evaluate(() => window.hibi.getDocument())).tabId, a)
})

test('close split that retries focus lets a file opened from outside go first', {
  timeout: 45000,
}, async (t) => {
  const { app, page, paths, idle } = await launchHolding(
    t,
    'hibi-tab-busy-close-split-retry-',
    { 'b.md': 'note b', 'a.md': 'note a' },
    ['document:focus-tab'],
  )
  const outside = join(dirname(paths['a.md']), 'outside.md')
  await writeFile(outside, 'note outside')
  const { tabId: a, tabs } = await page.evaluate(() =>
    window.hibi.getDocument(),
  )
  const b = tabs.find((tab) => tab.id !== a).id
  await splitTab(app, page, b)
  const closeSplit = page.getByRole('button', { name: 'Close split' })
  await closeSplit.waitFor()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    b,
  )
  await idle()
  // Going to the left pane's note fails, and so does going back: editing pauses
  // with the right pane's note shown.
  await app.evaluate(
    ({ ipcMain }, ids) => {
      const handlers = ipcMain._invokeHandlers
      const focus = handlers.get('document:focus-tab')
      let phase = 0
      handlers.set('document:focus-tab', async (...args) => {
        if (phase === 0 && args[1] === ids.a) {
          phase = 1
          const metadata = await focus(...args)
          return { ...metadata, contentVersion: metadata.contentVersion + 1 }
        }
        if (phase === 1 && args[1] === ids.b) {
          phase = 2
          throw new Error('Simulated focus rollback failure.')
        }
        globalThis.focusedAfter = (globalThis.focusedAfter ?? 0) + 1
        return focus(...args)
      })
    },
    { a, b },
  )
  await page.locator(`[data-tab-id="${a}"]`).click()
  await page.getByRole('button', { name: 'Retry document focus' }).waitFor()
  await openFromOutside(app, page, outside)
  await app.evaluate(() => globalThis.hold('document:external'))
  await closeSplit.click()
  await app.evaluate(() => globalThis.held['document:external'])
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => setTimeout(done))),
  )
  // Only the retry moved focus; the split waits for the file.
  assert.equal(await app.evaluate(() => globalThis.focusedAfter), 1)
  assert.equal(await closeSplit.isVisible(), true)
  await app.evaluate(() => globalThis.release['document:external']())
  await closeSplit.waitFor({ state: 'hidden' })
  await idle()
  const final = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(final.tabs.length, 3)
})

test('a tab clicked after close split during a save shows when both have run', {
  timeout: 30000,
}, async (t) => {
  const { app, page, idle } = await launchHolding(
    t,
    'hibi-tab-busy-close-split-click-',
    { 'c.md': 'note c', 'b.md': 'note b', 'a.md': 'note a' },
    [],
  )
  const { tabs } = await page.evaluate(() => window.hibi.getDocument())
  const b = tabs.find((tab) => tab.name === 'b.md').id
  const c = tabs.find((tab) => tab.name === 'c.md').id
  await splitTab(app, page, b)
  const closeSplit = page.getByRole('button', { name: 'Close split' })
  await closeSplit.waitFor()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    b,
  )
  await idle()
  await app.evaluate(() => globalThis.hold('document:save'))
  await clickMenu(app, 'Save')
  await app.evaluate(() => globalThis.held['document:save'])
  await closeSplit.click()
  await page.locator(`[data-tab-id="${c}"]`).click()
  await app.evaluate(() => globalThis.release['document:save']())
  await closeSplit.waitFor({ state: 'hidden' })
  await waitForAsync(
    page,
    async () => !document.querySelector('.app[aria-busy="true"]'),
  )
  await idle()
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => setTimeout(done))),
  )
  await idle()
  assert.equal((await page.evaluate(() => window.hibi.getDocument())).tabId, c)
})
