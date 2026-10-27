import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const owner = 'output-proof.probe:'

async function open(t, source, code, prepare) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-output-'))
  const profile = join(folder, 'profile')
  const file = join(folder, 'note.md')
  await writeFile(file, source)
  const addon = join(profile, 'installed-addons', 'output-proof')
  await mkdir(addon, { recursive: true })
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'output-proof',
      name: 'Output proof',
      description: 'Formatted output fixture',
      apiVersion: 3,
      capabilities: ['formatted'],
      version: '1.0.0',
      kind: 'extension',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(join(addon, 'index.js'), code)
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
    JSON.stringify({ 'output-proof': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  if (prepare) await page.evaluate(prepare)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    source,
  )
  await page
    .locator('.editor-panes[data-source-ready="true"] .rich-pane .cm-content')
    .waitFor()
  // Renderer focus stays inside a hidden test window.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  return { app, page, errors }
}

const frame = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )

async function type(page, keys) {
  for (const key of keys) {
    await page.keyboard.insertText(key)
    await frame(page)
  }
}

/** Puts the caret after the note's last word. */
const caretAtEnd = (page) =>
  page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    const at = view.state.doc.toString().lastIndexOf('end') + 3
    view.dispatch({ selection: { anchor: at } })
    view.focus()
  })

const state = (page) =>
  page.evaluate(async () => {
    const content = document.querySelector('.rich-pane .cm-content')
    return {
      canonical: (await window.hibi.getDocument()).markdown,
      view: content.cmTile.root.view.state.doc.toString(),
      text: content.innerText,
      strong: content.querySelectorAll('.hibi-lp-strong').length,
    }
  })

const reported = (page, text) =>
  page
    .locator('.toast')
    .filter({ hasText: text })
    .first()
    .waitFor({ timeout: 10000 })

const decorateProbe = `export default () => ({ start(context) {
  context.editor.registerFlavor({ id: 'probe', name: 'Probe', kind: 'syntax', description: 'Probe', detect: () => true,
    render: [{ nodes: ['Paragraph'], decorate(node, out, { state }) {
      const doc = state.doc
      if (window.probeMode === 'line') out.line(doc.length + 1, { class: 'probe-line' })
      if (window.probeMode === 'syntax' && doc.lineAt(node.from).number !== doc.lineAt(node.to).number)
        out.syntax(node.from, node.to)
    } }] })
} })`

for (const mode of ['line', 'syntax']) {
  test(`invalid decorate ${mode} output is reported with its owner and leaves core rendering and typing intact`, {
    timeout: 120000,
  }, async (t) => {
    const source = '# Title\n\n**strong** text\n\nalpha\nbeta\n\nend\n'
    const { page, errors } = await open(t, source, decorateProbe)
    await page.locator('.rich-pane .hibi-lp-strong').waitFor()
    await caretAtEnd(page)
    await page.evaluate((mode) => {
      window.probeMode = mode
    }, mode)
    await type(page, ['z', 'y'])
    const failed = await state(page)
    await page.evaluate(() => {
      window.probeMode = ''
    })
    await type(page, ['x'])
    const after = await state(page)
    t.diagnostic(JSON.stringify({ failed, after, errors }))
    const expected = source.replace('end', 'endzyx')
    assert.equal(failed.strong, 1, 'core formatting survives the failure')
    assert.equal(after.canonical, expected)
    assert.equal(after.view, expected)
    assert.equal(after.strong, 1)
    assert.match(after.text, /\bendzyx\n/)
    await reported(page, owner)
    assert.deepEqual(errors, [])
  })
}

for (const kind of ['inline', 'block']) {
  test(`a throwing ${kind} addon widget is reported with its owner and typing lands once`, {
    timeout: 120000,
  }, async (t) => {
    const source = '# Title\n\n**strong** text\n\n==mark== here\n\nend\n'
    const { page, errors } = await open(
      t,
      source,
      `export default sdk => ({ start(context) {
        const { WidgetType } = sdk.codeMirror.view
        class Rendered extends WidgetType {
          constructor(text) { super(); this.text = text }
          eq(other) { return other.text === this.text && !window.widgetFail }
          toDOM() {
            if (window.widgetFail) throw Error('render library rejected input')
            const span = document.createElement('span'); span.className = 'probe-widget'; span.textContent = this.text; return span
          }
          get estimatedHeight() { return ${kind === 'block' ? 24 : -1} }
        }
        const delimiter = { resolve: 'Mark', mark: 'MarkMark' }
        context.editor.registerFlavor({ id: 'probe', name: 'Probe', kind: 'syntax', description: 'Probe', detect: () => true,
          syntax: { defineNodes: ['Mark', 'MarkMark'], parseInline: [{ name: 'Mark', before: 'Escape', parse(cx, next, pos) {
            if (next !== 61 || cx.char(pos + 1) !== 61) return -1
            return cx.addDelimiter(delimiter, pos, pos + 2, true, true)
          } }] },
          render: [{ nodes: ['Mark'],
            ${
              kind === 'inline'
                ? `decorate(node, out, ctx) { if (ctx.revealed) return; out.replace(node.from, node.to, new Rendered(ctx.state.sliceDoc(node.from + 2, node.to - 2) + String(window.widgetFail || ''))) }`
                : `layout(node, out, ctx) { out.widget(ctx.state.doc.lineAt(node.to).to, new Rendered('block ' + String(window.widgetFail || '')), { block: true, side: 1 }) }`
            }
          }] })
      } })`,
    )
    await page.locator('.rich-pane .probe-widget').waitFor()
    await caretAtEnd(page)
    await page.evaluate(() => {
      window.widgetFail = true
    })
    await type(page, ['1', '2', '3'])
    const failed = await state(page)
    await page.evaluate(() => {
      window.widgetFail = false
    })
    await type(page, ['4'])
    const after = await state(page)
    t.diagnostic(JSON.stringify({ failed, after, errors }))
    assert.equal(failed.canonical, source.replace('end', 'end123'))
    assert.equal(failed.view, failed.canonical)
    const expected = source.replace('end', 'end1234')
    assert.equal(after.canonical, expected)
    assert.equal(after.view, expected)
    assert.match(after.text, /\bend1234\n/)
    assert.equal(after.strong, 1)
    await reported(page, owner)
    assert.deepEqual(errors, [])
  })
}

test('layout output beyond its node is reported with its owner and later blocks stay editable', {
  timeout: 120000,
}, async (t) => {
  const source = '# Title\n\n**strong** text\n\nalpha\nbeta\ngamma\n\nend\n'
  const { app, page, errors } = await open(
    t,
    source,
    `export default sdk => ({ start(context) {
      const { WidgetType } = sdk.codeMirror.view
      class Box extends WidgetType { toDOM() { const box = document.createElement('div'); box.className = 'probe-box'; box.textContent = 'box'; return box } eq() { return true } get estimatedHeight() { return 20 } }
      context.editor.registerFlavor({ id: 'probe', name: 'Probe', kind: 'syntax', description: 'Probe', detect: () => true,
        render: [{ nodes: ['Paragraph'], layout(node, out, { state }) {
          const doc = state.doc
          if (window.probeBeyond && doc.lineAt(node.from).number !== doc.lineAt(node.to).number)
            out.replace(node.from, doc.length + 7, new Box(), { block: true })
        } }] })
    } })`,
    () => {
      window.probeBeyond = true
    },
  )
  await caretAtEnd(page)
  await type(page, ['1', '2', '3'])
  await pressShortcut(app, 'Backspace')
  await frame(page)
  const after = await state(page)
  t.diagnostic(JSON.stringify({ after, errors }))
  const expected = source.replace('end', 'end12')
  assert.equal(after.canonical, expected)
  assert.equal(after.view, expected)
  assert.match(after.text, /\bend12\n/)
  await reported(page, owner)
  assert.deepEqual(errors, [])
})

test('a view update that throws while drawing resynchronizes the formatted view with the accepted text', {
  timeout: 120000,
}, async (t) => {
  const source = '# Title\n\n**strong** text\n\nend\n'
  const { app, page, errors } = await open(
    t,
    source,
    `export default sdk => ({ start(context) {
      const { Decoration, EditorView, WidgetType } = sdk.codeMirror.view
      const { StateField } = sdk.codeMirror.state
      // Draws fail once, as when a renderer rejects one input.
      class Length extends WidgetType {
        constructor(length) { super(); this.length = length }
        eq(other) { return other.length === this.length }
        toDOM() {
          if (window.failOnce) { window.failOnce = false; throw Error('transient draw failure') }
          const span = document.createElement('span'); span.className = 'resync-widget'; span.textContent = String(this.length); return span
        }
      }
      const widgets = (state) => Decoration.set([Decoration.widget({ widget: new Length(state.doc.length), side: 1 }).range(state.doc.line(1).to)])
      context.editor.registerFormatted({ id: 'resync', create: () => StateField.define({
        create: widgets,
        update: (value, transaction) => transaction.docChanged ? widgets(transaction.state) : value,
        provide: (field) => EditorView.decorations.from(field),
      }) })
    } })`,
  )
  await page.locator('.rich-pane .resync-widget').waitFor()
  await caretAtEnd(page)
  await page.evaluate(() => {
    window.failOnce = true
  })
  await type(page, ['1', '2', '3'])
  const after = await state(page)
  t.diagnostic(JSON.stringify({ after, errors }))
  const expected = source.replace('end', 'end123')
  assert.equal(
    await page.evaluate(() => window.failOnce),
    false,
    'the draw failed',
  )
  assert.equal(after.canonical, expected)
  assert.equal(after.view, expected)
  assert.match(after.text, /\bend123\n/)
  assert.equal(
    await page.locator('.rich-pane .resync-widget').textContent(),
    String(expected.length),
  )
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    source,
  )
  assert.equal((await state(page)).view, source)
  await pressShortcut(
    app,
    process.platform === 'win32' ? 'Control+y' : `${mod}+Shift+z`,
  )
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    expected,
  )
  const redone = await state(page)
  assert.equal(redone.view, expected)
  assert.match(redone.text, /\bend123\n/)
  assert.deepEqual(errors, [])
})
