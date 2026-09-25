import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, stopElectronTree } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

async function clickSourceLink(page, editor, text) {
  await page
    .locator(
      '.editor-panes[data-source-ready="true"] .source-pane:not([inert]) [contenteditable="true"]',
    )
    .waitFor()
  const point = await editor.evaluate(async (element, text) => {
    // Raw mouse coordinates need settled geometry after the pane slides in.
    await Promise.all(
      element
        .closest('.source-pane')
        .getAnimations()
        .filter((animation) =>
          Number.isFinite(animation.effect?.getComputedTiming().endTime),
        )
        .map((animation) => animation.finished),
    )
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode,
        at = node.textContent.indexOf(text)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at + 1)
      range.setEnd(node, at + 2)
      const box = range.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
  }, text)
  assert.ok(point)
  await page.keyboard.down('Shift')
  await page.mouse.click(point.x, point.y)
  await page.keyboard.up('Shift')
}

async function observeDocumentWorkers(page) {
  await page.evaluate(() => {
    window.documentWorkers = []
    window.Worker = new Proxy(window.Worker, {
      construct(target, args) {
        if (String(args[0]).includes('/document.worker-'))
          window.documentWorkers.push(String(args[0]))
        return Reflect.construct(target, args)
      },
    })
  })
}

async function waitForOpened(app, href) {
  const until = Date.now() + 6000
  while ((await app.evaluate(() => globalThis.openedReference)) !== href) {
    assert.ok(Date.now() < until, `Reference did not open ${href}`)
    await new Promise((done) => setTimeout(done, 20))
  }
}

test('source reference links use current definitions and coexist with find', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-reference-links-'))
  const source =
    '---\r\nvalue: |\r\n\r\n  [target]: https://metadata.invalid/\r\n---\r\n\r\n[reference][TARGET]\r\n\r\n[target]: https://first.example/\r\n\r\n[target]: https://second.example/\r\n'
  const path = join(root, 'references.md')
  await writeFile(path, source)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  const watchdog = setTimeout(() => stopElectronTree(app.process()), 25000)
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close().catch(() => {})
    clearTimeout(watchdog)
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .waitFor()
  await app.evaluate(({ dialog, shell }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    shell.openExternal = async (href) => {
      globalThis.openedReference = href
    }
  }, path)
  await pressShortcut(app, `${mod}+o`)
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'references.md',
  )
  await page.waitForFunction(
    () => document.querySelector('.app').getAttribute('aria-busy') === 'false',
  )
  await pressShortcut(app, `${mod}+Shift+\\`)
  const editor = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await editor.waitFor()
  await observeDocumentWorkers(page)
  await clickSourceLink(page, editor, 'reference')
  await waitForOpened(app, 'https://first.example/')
  await editor.click()
  await page.keyboard.press(`${mod}+a`)
  await page.keyboard.insertText(
    source.replace('https://first.example/', 'https://changed.example/'),
  )
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes(
      'https://changed.example/',
    ),
  )
  await pressShortcut(app, `${mod}+f`)
  const search = page.getByRole('textbox', {
    name: 'Find in document',
    exact: true,
  })
  await search.fill('target')
  await page.keyboard.press('Escape')
  await clickSourceLink(page, editor, 'reference')
  await waitForOpened(app, 'https://changed.example/')
  assert.equal(await page.evaluate(() => window.documentWorkers.length), 1)
})

test('rich-only addon syntax keeps source references out of the built-in reader', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-rich-reference-links-'))
  const profile = join(root, 'profile')
  const folder = join(profile, 'installed-addons', 'literal-definitions')
  const source =
    '[reference][target]\n\n[direct](https://direct.example/)\n\n[target]: https://must-not-open.example/\n'
  const path = join(root, 'references.md')
  await mkdir(folder, { recursive: true })
  await writeFile(path, source)
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'literal-definitions',
      name: 'Literal definitions',
      description: 'Rich-only reference syntax fixture',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      capabilities: ['rich'],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(folder, 'index.js'),
    `export default sdk => ({ start(context) {
      const literalDefinition = sdk.tiptap.Node.create({
        name: 'literalDefinition', group: 'block', content: 'text*',
        parseHTML: () => [{ tag: 'p.literal-definition' }],
        renderHTML: () => ['p', { class: 'literal-definition' }, 0],
        markdownTokenName: 'literalDefinition',
        markdownTokenizer: {
          name: 'literalDefinition', level: 'block',
          start: source => source.search(/^\\[[^\\]]+\\]:/m),
          tokenize(source) {
            const match = /^\\[[^\\]]+\\]:[^\\n]*(?:\\n|$)/.exec(source);
            if (match) return { type: 'literalDefinition', raw: match[0], text: match[0].trim() };
          }
        },
        parseMarkdown: (token, helpers) => helpers.createNode('literalDefinition', undefined, [{ type: 'text', text: token.text }]),
        renderMarkdown: (node, helpers) => helpers.renderChildren(node.content || [])
      });
      context.editor.registerFlavor({
        id: 'rich-only', name: 'Literal definitions', kind: 'syntax',
        description: 'Reference definitions remain literal text.',
        detect: () => true, richExtensions: [literalDefinition]
      });
    } });`,
  )
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'literal-definitions': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  const watchdog = setTimeout(() => stopElectronTree(app.process()), 25000)
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close().catch(() => {})
    clearTimeout(watchdog)
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .waitFor()
  await app.evaluate(({ dialog, shell }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    shell.openExternal = async (href) => {
      globalThis.openedReference = href
    }
  }, path)
  await pressShortcut(app, `${mod}+o`)
  await page.locator('.literal-definition').waitFor()
  assert.equal(
    await page.locator('.literal-definition').textContent(),
    '[target]: https://must-not-open.example/',
  )
  assert.equal(await page.locator('.tiptap a').count(), 1)
  await page.waitForFunction(
    () => document.querySelector('.app').getAttribute('aria-busy') === 'false',
  )
  await pressShortcut(app, `${mod}+Shift+\\`)
  const editor = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await editor.waitFor()
  await observeDocumentWorkers(page)
  await clickSourceLink(page, editor, 'reference')
  // A tiny source bootstrap has at most two task turns before worker creation.
  await page.evaluate(
    () => new Promise((done) => setTimeout(() => setTimeout(done, 0), 0)),
  )
  assert.equal(await page.evaluate(() => window.documentWorkers.length), 0)
  assert.equal(await app.evaluate(() => globalThis.openedReference), undefined)
  await clickSourceLink(page, editor, 'direct')
  await waitForOpened(app, 'https://direct.example/')
  assert.equal(await page.evaluate(() => window.documentWorkers.length), 0)
})
