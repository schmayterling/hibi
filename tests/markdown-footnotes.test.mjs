import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { Marked } from 'marked'
import { markedGithubFootnote } from 'marked-github-footnote'
import { exportOptions } from '../src/addons/documentation/options.ts'
import { prepareSite, siteFiles } from '../src/addons/documentation/site.ts'
import { DocumentRuntime } from '../src/renderer/src/document-runtime.ts'
import { hasDocumentFootnotes } from '../src/renderer/src/document-shell.ts'
import { hasFootnoteDefinitions } from '../src/shared/markdown-footnotes.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut, replaceSourceText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const source =
  'A note[^source] and another reference[^source].\n\n' +
  '[^source]: **First** line.\n    Second line.'

test('footnote definitions are distinguished from code and ordinary links', () => {
  assert.equal(hasFootnoteDefinitions(source), true)
  assert.equal(hasFootnoteDefinitions('```md\n[^source]: note\n```'), false)
  assert.equal(
    hasFootnoteDefinitions('A [link][source].\n\n[source]: url'),
    false,
  )
  assert.equal(hasFootnoteDefinitions('An unresolved note[^source].'), false)
})

test('legacy synchronous footnote fallback sees definitions behind invalid titles', async () => {
  const repro = '[ref]: /x "a\n\n[^1]: note\n"\n\ntext[^1]'
  const code = '```md\n[^source]: note\n```'
  // Plain marked misses this definition; the lazy block grammar finds it.
  assert.equal(hasFootnoteDefinitions(repro), false)
  const runtime = { sourceFor: (document) => document.source }
  const note = (markdown) => ({ markdown, source: { utf16Length: 0 } })
  const [invalidTitle, fenced, plain] = [repro, code, source].map(note)
  // Before the block grammar loads, unplaced definitions keep rich views closed.
  assert.equal(hasDocumentFootnotes(runtime, invalidTitle), true)
  assert.equal(hasDocumentFootnotes(runtime, fenced), true)
  await import('../src/renderer/src/markdown-detectors.ts')
  assert.equal(hasFootnoteDefinitions(repro), true)
  assert.equal(hasDocumentFootnotes(runtime, invalidTitle), true)
  assert.equal(hasDocumentFootnotes(runtime, fenced), false)
  assert.equal(hasDocumentFootnotes(runtime, plain), true)
})

test('shell renders lex each unchanged source once across panes and unsaved edits', async (t) => {
  await import('../src/renderer/src/markdown-detectors.ts')
  let lexes = 0
  const { lexer } = Marked.prototype
  Marked.prototype.lexer = function (...input) {
    lexes++
    return lexer.apply(this, input)
  }
  t.after(() => {
    Marked.prototype.lexer = lexer
  })
  const runtime = new DocumentRuntime({
    enqueue() {},
    onError(error) {
      throw error
    },
  })
  t.after(() => runtime.dispose())
  const tabs = ['notes', 'example'].map((id) => ({
    id,
    name: `${id}.md`,
    dirty: false,
  }))
  const open = (tabId, markdown) =>
    runtime.activate({
      tabId,
      tabs,
      tabsEnabled: true,
      id: `file-${tabId}`,
      ephemeral: false,
      markdown,
      savedMarkdown: markdown,
      name: `${tabId}.md`,
      dirty: false,
      revision: 1,
      contentVersion: 0,
      canAutosave: true,
    })
  // A fenced example still passes the cheap marker test.
  open('example', '```md\n[^source]: note\n```')
  let shell = open('notes', source)
  // The app checks its latest active source, then each rendered pane.
  const render = (split) =>
    [
      runtime.get(),
      ...(split ? [runtime.get('notes'), runtime.get('example')] : [shell]),
    ].map((document) => hasDocumentFootnotes(runtime, document))
  for (let i = 0; i < 20; i++) assert.deepEqual(render(false), [true, true])
  assert.equal(lexes, 1)
  for (let i = 0; i < 20; i++)
    assert.deepEqual(render(true), [true, true, false])
  assert.equal(lexes, 2)

  // Unsaved edits keep the disk revision but publish a new source.
  runtime.replace(`${source.replace('[^source]:', '```\n[^source]:')}\n\`\`\``)
  assert.equal(runtime.get().revision, 1)
  assert.equal(runtime.get().dirty, true)
  assert.deepEqual(render(false), [false, true])
  shell = runtime.get()
  for (let i = 0; i < 20; i++) assert.deepEqual(render(false), [false, false])
  for (let i = 0; i < 20; i++)
    assert.deepEqual(render(true), [false, false, false])
  assert.equal(lexes, 3)

  // A save acknowledgment changes shell metadata, not the source.
  const edited = runtime.get()
  runtime.acknowledgeSave(
    { ...edited, savedMarkdown: edited.markdown },
    runtime.beginSave(),
  )
  shell = runtime.get()
  assert.notEqual(shell, edited)
  assert.equal(shell.dirty, false)
  for (let i = 0; i < 20; i++)
    assert.deepEqual(render(true), [false, false, false])
  assert.equal(lexes, 3)

  runtime.session().undo()
  shell = runtime.get()
  assert.equal(shell.markdown, source)
  for (let i = 0; i < 20; i++)
    assert.deepEqual(render(true), [true, true, false])
  assert.equal(lexes, 4)
})

test('footnotes render once per reference and retain export anchors', async () => {
  const parser = new Marked({ gfm: true }, markedGithubFootnote())
  const rendered = parser.parse(source, { async: false })
  assert.match(rendered, /id="fnref-source"/)
  assert.match(rendered, /id="fnref-source-2"/)
  assert.match(rendered, /<li id="fn-source">/)
  assert.match(rendered, /<strong>First<\/strong>/)
  assert.match(rendered, /Second line/)
  assert.match(
    parser.parse('missing[^unknown]', { async: false }),
    /\[\^unknown\]/,
  )

  const template = await readFile('out/site/template.html', 'utf8')
  for (const singleFile of [true, false]) {
    const site = prepareSite(
      {
        name: 'Notes',
        pages: [{ path: 'README.md', markdown: source, html: rendered }],
      },
      exportOptions({ singleFile }),
    )
    assert.match(site.pages[0].html, /id="fnref-source"/)
    assert.match(site.pages[0].html, /data-footnotes/)
    const files = await siteFiles(template, site)
    const exported = files.get(
      singleFile ? 'index.html' : 'README.md/index.html',
    )
    assert.match(exported, /id="fnref-source"/)
    assert.match(exported, /id="fn-source"/)
    assert.match(exported, /id="footnote-label"/)
    assert.match(exported, /data-footnotes/)
    assert.match(exported, /data-footnote-backref/)
    assert.match(
      exported,
      singleFile
        ? /href="#page=README.md&amp;anchor=fn-source"/
        : /href="[^"]*#fn-source"/,
    )
  }
  const hostile = prepareSite(
    {
      name: 'Notes',
      pages: [
        {
          path: 'README.md',
          markdown: source,
          html: `${rendered}<a id="root" data-footnote-ref href="#fn-source" onclick="window.attack=true">fake</a><li id="root">fake</li>`,
        },
      ],
    },
    exportOptions(),
  )
  assert.doesNotMatch(hostile.pages[0].html, /id="root"|onclick/)
})

test('exported footnote links survive site hydration', {
  timeout: 45000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-site-footnotes-'))
  const markdown = source.replace(
    '\n\n[^source]:',
    `\n\n${'A long paragraph between the note and its definition.\n\n'.repeat(60)}[^source]:`,
  )
  const parser = new Marked({ gfm: true }, markedGithubFootnote())
  const site = prepareSite(
    {
      name: 'Notes',
      pages: [
        {
          path: 'README.md',
          markdown,
          html: parser.parse(markdown, { async: false }),
        },
      ],
    },
    exportOptions(),
  )
  const template = await readFile('out/site/template.html', 'utf8')
  const files = await siteFiles(template, site)
  const file = join(folder, 'index.html')
  await writeFile(file, files.get('index.html'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.firstWindow()
  const next = app.waitForEvent('window')
  const target = await app.evaluate(({ app, BrowserWindow }, url) => {
    const observation = {
      startedAt: performance.now(),
      counts: {
        created: 0,
        start: 0,
        navigate: 0,
        dom: 0,
        finish: 0,
        fail: 0,
        gone: 0,
        unresponsive: 0,
        responsive: 0,
        console: 0,
      },
      events: [],
      dropped: 0,
      errors: 0,
    }
    globalThis.__hibiFootnoteSite = observation
    const clip = (value) => String(value ?? '').slice(0, 160)
    const record = (kind, read = () => []) => {
      observation.counts[kind]++
      try {
        const row = [
          Math.round(performance.now() - observation.startedAt),
          kind,
          observation.counts[kind],
          ...read(),
        ]
        if (observation.events.length === 24) {
          observation.events.splice(6, 1)
          observation.dropped++
        }
        observation.events.push(row)
      } catch {
        observation.errors++
      }
    }
    app.on('browser-window-created', (_event, window) =>
      record('created', () => [window.id, window.webContents.id]),
    )
    const viewer = new BrowserWindow({
      show: false,
      width: 1000,
      height: 780,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    const contents = viewer.webContents
    contents.on('did-start-loading', () => record('start'))
    contents.on('did-navigate', () => record('navigate'))
    contents.on('dom-ready', () => record('dom'))
    contents.on('unresponsive', () => record('unresponsive'))
    contents.on('responsive', () => record('responsive'))
    contents.on('did-finish-load', () =>
      record('finish', () => [clip(contents.getURL())]),
    )
    contents.on('did-fail-load', (_event, code, description, url, mainFrame) =>
      record('fail', () => [code, clip(description), clip(url), mainFrame]),
    )
    contents.on('render-process-gone', (_event, details) =>
      record('gone', () => [clip(details.reason), details.exitCode]),
    )
    contents.on('console-message', (details) =>
      record('console', () => [
        clip(details.level),
        clip(details.message),
        clip(details.sourceId),
        details.lineNumber,
      ]),
    )
    void viewer.loadURL(url)
    return { windowId: viewer.id, webContentsId: contents.id }
  }, pathToFileURL(file).href)
  const page = await next
  page.setDefaultTimeout(7000)
  await page
    .getByRole('button', { name: /^toggle navigation$/i })
    .waitFor()
    .catch(async (error) => {
      const bounded = async (request) => {
        let timer
        try {
          return await Promise.race([
            Promise.resolve()
              .then(request)
              .catch(() => ({ unavailable: true })),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve({ unavailable: true }), 1000)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      try {
        const [main, selected, dom, consoleMessages, pageErrors] =
          await Promise.all([
            bounded(() =>
              app.evaluate(({ app, BrowserWindow }, target) => {
                const describe = (window) => {
                  try {
                    const contents = window.webContents
                    return {
                      windowId: window.id,
                      webContentsId: contents.id,
                      url: contents.getURL().slice(0, 240),
                      loading: contents.isLoadingMainFrame(),
                      pid: contents.getOSProcessId(),
                      crashed: contents.isCrashed(),
                      waiting: contents.isWaitingForResponse(),
                    }
                  } catch {
                    return { unavailable: true }
                  }
                }
                const windows = BrowserWindow.getAllWindows()
                return {
                  intended: describe(BrowserWindow.fromId(target.windowId)),
                  windows: windows.slice(0, 8).map(describe),
                  omittedWindows: Math.max(0, windows.length - 8),
                  // Cumulative cpu separates a busy renderer from a blocked one.
                  processes: app
                    .getAppMetrics()
                    .slice(0, 12)
                    .map(({ pid, type, creationTime, cpu }) => [
                      pid,
                      type,
                      Math.round(Date.now() - creationTime),
                      Math.round(cpu.percentCPUUsage),
                      cpu.cumulativeCPUUsage?.toFixed(2),
                    ]),
                  observation: globalThis.__hibiFootnoteSite ?? {
                    unavailable: true,
                  },
                }
              }, target),
            ),
            bounded(async () => {
              const handle = await app.browserWindow(page)
              try {
                return await handle.evaluate((window) => ({
                  windowId: window.id,
                  webContentsId: window.webContents.id,
                  url: window.webContents.getURL().slice(0, 240),
                }))
              } finally {
                await handle.dispose()
              }
            }),
            bounded(() =>
              page.evaluate(() => {
                const nav = document.querySelector(
                  'button[aria-label="Toggle navigation" i]',
                )
                return {
                  url: location.href.slice(0, 240),
                  readyState: document.readyState,
                  rootChildren:
                    document.getElementById('root')?.childElementCount,
                  siteCount: document.querySelectorAll('.documentation-site')
                    .length,
                  navigationCount: document.querySelectorAll(
                    'button[aria-label="Toggle navigation" i]',
                  ).length,
                  navigation: nav && {
                    hidden: nav.hidden,
                    display: getComputedStyle(nav).display,
                    visibility: getComputedStyle(nav).visibility,
                    rects: nav.getClientRects().length,
                  },
                  footnotes: {
                    references: document.querySelectorAll(
                      'a[data-footnote-ref]',
                    ).length,
                    definitions:
                      document.querySelectorAll('li#fn-source').length,
                    labels:
                      document.querySelectorAll('h2#footnote-label').length,
                    backlinks: document.querySelectorAll(
                      'a[data-footnote-backref]',
                    ).length,
                  },
                }
              }),
            ),
            bounded(() =>
              page.consoleMessages().then((messages) => ({
                cached: messages.length,
                tail: messages.slice(-4).map((message) => ({
                  type: message.type(),
                  text: message.text().slice(0, 240),
                })),
              })),
            ),
            bounded(() =>
              page.pageErrors().then((errors) => ({
                cached: errors.length,
                tail: errors.slice(-3).map((error) => ({
                  message: error.message.slice(0, 240),
                  stack: error.stack?.slice(0, 240),
                })),
              })),
            ),
          ])
        console.error(
          'footnote site startup:',
          JSON.stringify({
            target,
            expectedUrl: pathToFileURL(file).href.slice(0, 240),
            main,
            selected,
            dom,
            consoleMessages,
            pageErrors,
          }),
        )
      } catch {}
      throw error
    })
  assert.equal(
    await page.locator('a#fnref-source[data-footnote-ref]').count(),
    1,
  )
  assert.equal(
    await page.locator('a#fnref-source-2[data-footnote-ref]').count(),
    1,
  )
  assert.equal(await page.locator('li#fn-source').count(), 1)
  assert.equal(await page.locator('h2#footnote-label').count(), 1)
  await page.locator('a#fnref-source[data-footnote-ref]').click()
  await page.waitForFunction(
    () => document.querySelector('.site-content')?.scrollTop > 0,
  )
  assert.match(page.url(), /anchor=fn-source/)
  await page.locator('a[data-footnote-backref]').first().click()
  await page.waitForFunction(() =>
    location.hash.includes('anchor=fnref-source'),
  )
})

test('source footnotes preview and save without changing markdown', {
  timeout: 45000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-footnotes-'))
  const file = join(temp, 'footnotes.md')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6500)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await pressShortcut(app, `${mod}+Shift+]`)
  const editor = page.getByRole('textbox', { name: /markdown editor/i })
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(page, editor, source)
  await page.getByRole('button', { name: /^side-by-side$/i }).click()
  const preview = page.locator('.markdown-footnote-preview')
  await preview.locator('[data-footnotes]').waitFor()
  assert.equal(
    await page.getByRole('button', { name: /^normal$/i }).isDisabled(),
    true,
  )
  assert.equal(await preview.locator('[data-footnote-ref]').count(), 2)
  assert.equal(
    await preview.locator('li#fn-source strong').innerText(),
    'First',
  )
  assert.equal(await preview.locator('[data-footnote-backref]').count(), 2)
  assert.equal(await windowMarkdown(page), source)

  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, file)
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), source)

  await replaceSourceText(
    page,
    editor,
    'Unsafe[^note].\n\n[^note]: <img src="x" onerror="window.footnoteAttack=true">',
  )
  await preview.locator('li#fn-note img').waitFor({ state: 'attached' })
  assert.equal(
    await preview.locator('li#fn-note img').getAttribute('onerror'),
    null,
  )
  assert.equal(
    await preview.locator('li#fn-note img').getAttribute('src'),
    null,
  )
  assert.equal(await page.evaluate(() => window.footnoteAttack), undefined)
  assert.deepEqual(errors, [])
})

async function windowMarkdown(page) {
  return page.evaluate(async () => (await window.hibi.getDocument()).markdown)
}
