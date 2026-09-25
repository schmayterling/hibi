import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { Marked } from 'marked'
import { markedGithubFootnote } from 'marked-github-footnote'
import { exportOptions } from '../src/addons/documentation/options.ts'
import { prepareSite, siteFiles } from '../src/addons/documentation/site.ts'
import { hasFootnoteDefinitions } from '../src/shared/markdown-footnotes.ts'
import { electron } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
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
  await editor.fill(source)
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

  await editor.fill(
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
