import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createTraceFinalizer } from '../scripts/trace-stream.mjs'
import { electron, waitForDocumentEditor } from './electron.mjs'

test('list spacing preserves nested blocks without restyling unrelated siblings', {
  timeout: 60000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-list-styles-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  const css = await readFile('src/renderer/src/styles.css', 'utf8')
  const from = css.indexOf('/* Items and nested lists')
  const to = css.indexOf(':is(.tiptap, .format-content) blockquote {', from)
  assert.ok(from >= 0 && to > from)
  await page.evaluate(
    async (css) => {
      const frame = document.createElement('iframe')
      frame.id = 'list-style-check'
      const loaded = new Promise((done) => {
        frame.onload = done
      })
      frame.srcdoc =
        '<style>:root{--text-editor:16px}p{margin:0 0 16px}</style><main class="cm-content"></main>'
      document.body.append(frame)
      await loaded
      const doc = frame.contentDocument
      const style = doc.createElement('style')
      style.textContent = css
      doc.head.append(style)
      const root = doc.querySelector('main')
      for (let i = 0; i < 80; i++) {
        const line = doc.createElement('div')
        line.textContent = `paragraph ${i}`
        root.append(line)
      }
      void doc.defaultView.getComputedStyle(root).whiteSpace
    },
    css.slice(from, to),
  )
  const session = await page.context().newCDPSession(page)
  const frames = await session.send('Page.getFrameTree')
  const frame = frames.frameTree.childFrames.find(
    ({ frame }) => frame.url === 'about:srcdoc',
  ).frame.id
  const trace = join(folder, 'style.trace.json')
  const finish = createTraceFinalizer(session, trace)
  await session.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    categories: 'devtools.timeline',
  })
  await page.evaluate(() => {
    const doc = document.getElementById('list-style-check').contentDocument
    const root = doc.querySelector('main')
    for (let i = 0; i < 20; i++) {
      const line = doc.createElement('div')
      root.prepend(line)
      void doc.defaultView.getComputedStyle(root).whiteSpace
      root.lastElementChild.remove()
      void doc.defaultView.getComputedStyle(root).whiteSpace
    }
  })
  await finish()
  const events = JSON.parse(await readFile(trace, 'utf8')).traceEvents
  const styled = events
    .filter(
      (event) =>
        event.name === 'UpdateLayoutTree' &&
        event.args?.beginData?.frame === frame,
    )
    .reduce((sum, event) => sum + event.args.elementCount, 0)
  assert.ok(styled > 0 && styled <= 80, `restyled ${styled} unrelated elements`)
  t.diagnostic(`unrelated elements restyled: ${styled}`)
  const margins = await page.evaluate(() => {
    const doc = document.getElementById('list-style-check').contentDocument
    const markup =
      '<ul><li><p>first</p><h2>heading</h2><p>second</p><ul><li><p>nested</p><p>next</p></li></ul></li><li><label><input type="checkbox"></label><div><p>task</p><p>next task</p><ol><li>ordered</li></ol></div></li></ul>'
    return ['tiptap', 'format-content'].map((kind) => {
      const root = doc.createElement('section')
      root.className = kind
      root.innerHTML = markup
      doc.body.append(root)
      return [...root.querySelectorAll('*:not(input)')].map((element) => {
        const style = doc.defaultView.getComputedStyle(element)
        return [element.tagName, style.marginTop, style.marginBottom]
      })
    })
  })
  const expected = [
    ['UL', '16px', '16px'],
    ['LI', '0px', '0px'],
    ['P', '0px', '0px'],
    ['H2', '16px', '0px'],
    ['P', '16px', '0px'],
    ['UL', '4.8px', '0px'],
    ['LI', '0px', '0px'],
    ['P', '0px', '0px'],
    ['P', '16px', '0px'],
    ['LI', '4.8px', '0px'],
    ['LABEL', '0px', '0px'],
    ['DIV', '0px', '0px'],
    ['P', '0px', '0px'],
    ['P', '16px', '0px'],
    ['OL', '4.8px', '0px'],
    ['LI', '0px', '0px'],
  ]
  assert.deepEqual(margins, [expected, expected])
  const alerts = await readFile('src/addons/markdown/alerts.css', 'utf8')
  const alertMargins = await page.evaluate(
    ({ css, alerts }) => {
      const doc = document.getElementById('list-style-check').contentDocument
      for (const style of doc.head.querySelectorAll('style')) style.remove()
      const sheet = doc.createElement('style')
      sheet.textContent = css + '\n' + alerts
      doc.head.append(sheet)
      return ['tiptap', 'format-content'].map((kind) => {
        const root = doc.createElement('section')
        root.className = kind
        root.style.setProperty('--text-editor', '16px')
        root.innerHTML =
          '<ul><li><blockquote class="github-alert">first</blockquote><p>gap</p><blockquote class="github-alert">later</blockquote></li><li><label></label><div><blockquote class="github-alert">task</blockquote></div></li></ul>'
        doc.body.append(root)
        return [...root.querySelectorAll('blockquote')].map((element) => {
          const style = doc.defaultView.getComputedStyle(element)
          return [style.marginTop, style.marginBottom]
        })
      })
    },
    { css, alerts },
  )
  const expectedAlerts = [
    ['0px', '0px'],
    ['16px', '0px'],
    ['0px', '0px'],
  ]
  assert.deepEqual(alertMargins, [expectedAlerts, expectedAlerts])
})
