import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { RenderedTextIndex } from '../src/shared/rendered-text.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { replaceSourceText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('rendered worker projection agrees with actual unrevealed formatted DOM', {
  timeout: 60000,
}, async (t) => {
  const markdown = [
    '- alpha\n\t- beta',
    'hello ==world==',
    'see [[Page|Alias]] now',
    'see https://example.com/__init__ ok',
    'H~2~O',
    'Title\n===',
    '- [ ] task',
    '> [!NOTE]\n> body',
    '> - quoted *item*\n>   cont',
    '> - a\n>   b',
    '> 1. a\n>    b',
    '> a\n>  b',
    '>> - nested\n>>   continuation',
    '<div>\n*a* b\n</div>',
    'hello\nworld',
    'x [label](b y',
    'A &amp; B',
    'a \\*literal\\* word',
    'use \x60code &amp;\\*\x60 now',
    '-# small **text**',
    'ref [^1]\n\n[^1]: footnote\n    continued',
    '[hidden]: https://hidden.example.test',
    '- [hidden-item]: https://hidden.example.test\n\n  shown content',
    'sentinel',
  ].join('\n\n')
  const profile = await mkdtemp(join(tmpdir(), 'hibi-rendered-dom-'))
  const app = await electron.launch({
    args: [resolve('.'), '--user-data-dir=' + profile],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.setViewportSize({ width: 1200, height: 2800 })
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (message, ...rest) {
      const request = message.message ?? message
      if (request.type === 'boundaries')
        window.formattedTextConfig = request.config
      return post.call(this, message, ...rest)
    }
  })
  const rich = await selectFormattedEngine(app, page, 'codemirror')
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(
    page,
    page.getByRole('textbox', { name: 'Markdown editor', exact: true }),
    markdown,
  )
  await waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown === text,
    markdown,
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.waitFor()
  await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({ selection: { anchor: view.state.doc.length } })
  })
  await waitForAsync(
    page,
    () =>
      window.formattedTextConfig?.textSyntax?.includes('obsidian@1') &&
      document
        .querySelector('.rich-pane .hibi-formatted .cm-content')
        ?.textContent.includes('Alias'),
  )
  const config = await page.evaluate(() => window.formattedTextConfig)
  const store = new SourceStore(markdown, { tabId: 'dom', revision: 0 })
  const index = new RenderedTextIndex(store.snapshot(), config.prefix, config)
  for (const _ of index.build()) {
  }
  const lines = await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    return [...element.querySelectorAll('.cm-line')]
      .map((line) => {
        const clone = line.cloneNode(true)
        clone.querySelectorAll('.cm-widgetBuffer').forEach((node) => {
          node.remove()
        })
        return {
          from: view.posAtDOM(line, 0),
          to: view.posAtDOM(line, line.childNodes.length),
          text: clone.textContent,
        }
      })
      .filter((line) => line.text && line.from < line.to)
  })
  assert.ok(lines.length >= 15, JSON.stringify(lines))
  for (const source of [
    '>   cont',
    '>   b',
    '>    b',
    '>  b',
    '>>   continuation',
  ]) {
    const at = markdown.indexOf(source) + source.length - 1
    assert.ok(
      lines.some((line) => line.from <= at && line.to > at),
      'missing oracle line: ' + source,
    )
  }
  for (const line of lines) {
    const projected = [...index.range(line.from, line.to)]
      .map((chunk) => chunk.text)
      .join('')
    assert.equal(
      projected,
      line.text,
      JSON.stringify({ source: markdown.slice(line.from, line.to), ...line }),
    )
  }
  t.diagnostic(
    JSON.stringify({
      comparedLines: lines.length,
      flavors: config.flavors,
      syntax: config.textSyntax,
    }),
  )
})
