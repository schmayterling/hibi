import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { electron } from './electron.mjs'
import { testFormattedEngines as test } from './formatted-engine.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

async function blockedEditor(t) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-editor-loading-'))
  const chunks = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const entry = chunks.find((chunk) =>
    chunk.modules.includes(
      t.formattedEngine === 'codemirror'
        ? 'src/renderer/src/FormattedEditor.tsx'
        : 'src/renderer/src/Editor.tsx',
    ),
  )
  assert.ok(entry)
  const otherEntry = chunks.find((chunk) =>
    chunk.modules.includes(
      t.formattedEngine === 'codemirror'
        ? 'src/renderer/src/Editor.tsx'
        : 'src/renderer/src/FormattedEditor.tsx',
    ),
  )
  assert.ok(otherEntry)
  assert.notEqual(entry.file, otherEntry.file)
  const bootstrap = join(profile, 'bootstrap.mjs')
  // Install before the first request; renderer reloads can reuse module assets.
  // The production protocol still performs its normal path and CSP checks.
  await writeFile(
    bootstrap,
    `import { net } from 'electron';
    const fetch = net.fetch;
    let blocked = false;
    net.fetch = async (...args) => {
      if (String(args[0]).endsWith(${JSON.stringify(otherEntry.file)}))
        globalThis.otherEditorRequested = true;
      if (!blocked && String(args[0]).endsWith(${JSON.stringify(entry.file)})) {
        blocked = true;
        await new Promise((resolve, reject) => {
          globalThis.releaseEditorRequest = fail => {
            net.fetch = fetch;
            if (fail) reject(Error('Fixture module load failure'));
            else resolve();
          };
        });
      }
      return fetch.apply(net, args);
    };
    await import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});`,
  )
  const app = await electron.launch({
    args: [bootstrap, `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  // Keep the first selected-engine request blocked under either default.
  await page.waitForURL('app://hibi/', { waitUntil: 'commit' })
  await page.evaluate((engine) => {
    localStorage.setItem('hibi:formatted-engine', engine)
  }, t.formattedEngine)
  await waitForAsync(
    app,
    () =>
      typeof globalThis.releaseEditorRequest === 'function' ||
      globalThis.otherEditorRequested,
  )
  if (
    await app.evaluate(
      () => typeof globalThis.releaseEditorRequest !== 'function',
    )
  )
    await page.reload({ waitUntil: 'commit' })
  await waitForAsync(
    app,
    () => typeof globalThis.releaseEditorRequest === 'function',
  )
  await page.waitForFunction(() => {
    const editor = document.querySelector('.editor-page')
    return editor && !editor.inert
  })
  assert.equal(await page.locator('.tiptap').count(), 0)
  assert.equal(await page.locator('.hibi-formatted').count(), 0)
  return { app, page, profile }
}

test('pending rich module keeps shell usable and late completion preserves standalone input', {
  timeout: 30000,
}, async (t) => {
  const { app, page, profile } = await blockedEditor(t)
  const file = join(profile, 'plain.txt')
  await writeFile(file, 'literal **text**\r\n')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    })
  }, file)
  await clickMenu(app, 'Open…')
  const source = page.getByRole('textbox', {
    name: 'Plain text editor',
    exact: true,
  })
  await source.waitFor()
  const element = await source.elementHandle()
  await source.focus()
  await page.keyboard.insertText('!')
  await waitForAsync(page, async () => (await window.hibi.getDocument()).dirty)
  await app.evaluate(() => globalThis.releaseEditorRequest(false))
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  assert.equal(await page.locator('.tiptap').count(), 0)
  assert.equal(await page.locator('.hibi-formatted').count(), 0)
  assert.equal(
    await element.evaluate(
      (element) => element.isConnected && document.activeElement === element,
    ),
    true,
  )
  assert.ok(
    (await page.evaluate(() => window.hibi.getDocument())).markdown.includes(
      '!',
    ),
  )
  await clickMenu(app, 'New')
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await rich.waitFor()
  await rich.focus()
  await page.keyboard.insertText('rich after source')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'rich after source',
  )
})

test('failed rich module reaches draft recovery and reload can retry it', {
  timeout: 30000,
}, async (t) => {
  const { app, page } = await blockedEditor(t)
  await app.evaluate(() => globalThis.releaseEditorRequest(true))
  await page
    .getByRole('main', { name: 'Editor recovery', exact: true })
    .waitFor()
  await page.getByText('Document available', { exact: true }).waitFor()
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    globalThis.recoveryNavigation = new Promise((resolve) =>
      contents.once('will-frame-navigate', (event) =>
        resolve({
          url: event.url,
          prevented: event.defaultPrevented,
        }),
      ),
    )
  })
  await page
    .getByRole('button', { name: 'Reload Hibi', exact: true })
    .click({ noWaitAfter: true })
  assert.deepEqual(await app.evaluate(() => globalThis.recoveryNavigation), {
    url: 'app://hibi/',
    prevented: false,
  })
  const editor = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await editor.waitFor()
  await editor.focus()
  await page.keyboard.insertText('recovered')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'recovered',
  )
})
