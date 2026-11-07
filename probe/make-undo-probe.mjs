// Writes tests/zz-undo-probe.test.mjs: editor-input plus one probe test that
// repeats partial pick edits, then undo through pressShortcut, and logs per
// rep whether the renderer saw the undo key before the test's first read and
// what that read and a later settled read held. Throwaway diagnostic, never merged.
import { readFileSync, writeFileSync } from 'node:fs'
const dir = process.argv[2]
const reps = Number(process.argv[3] ?? 30)
let s = readFileSync(dir + '/tests/editor-input.test.mjs', 'utf8')
const anchor = '// Cut over a pick puts on the clipboard'
if (!s.includes(anchor)) throw new Error('missing anchor')
const probe = `
test('undo probe', { timeout: 1800000 }, async (t) => {
  const table = '| hh | ii |\\n| --- | --- |\\n| abc | def |\\n| ghi | jkl |'
  const counts = {}
  const variants = [
    ['rows', table, ['abc', 1, true], ['jkl', 2, true], 'composition', true],
    ['rows', table, ['abc', 1, true], ['jkl', 2, true], 'composition', false],
    ['rows', table, ['abc', 1, true], ['jkl', 2, true], 'Backspace', true],
    ['rows', table, ['abc', 1, true], ['jkl', 2, true], 'Enter', true],
  ]
  for (let rep = 0; rep < ${reps}; rep++)
    for (const [what, source, a, b, edit, reverse] of variants) {
      const label = what + ': ' + edit + (reverse ? ' backward' : '')
      const from = source.indexOf(a[0]) + a[1]
      const to = source.indexOf(b[0]) + b[1]
      const { app, page, rich } = await openInputFixture(source)
      await selectNativeInputTable(t, page, rich, 'cells', {
        source, from, to, pick: [a, b], cell: from,
        text: source.slice(from, to).replace(/[|\\s-]/g, ''),
      }, reverse)
      if (edit === 'composition') {
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 })
        await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 })
        await cdp.send('Input.insertText', { text: '日本' })
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 229 })
        await cdp.detach()
      } else await page.keyboard.press(edit)
      const edited = (await acceptedInput(page)).markdown
      await page.evaluate(() => {
        const doc = () => document.querySelector('.rich-pane [aria-label="Document editor"]')?.cmTile.root.view.state.doc.toString()
        window.undoProbe = { down: null, up: null, after: null }
        if (window.undoProbeInstalled) return
        window.undoProbeInstalled = true
        window.addEventListener('keydown', (event) => {
          if (event.key.toLowerCase() !== 'z' || !window.undoProbe) return
          window.undoProbe.down = { at: performance.now(), doc: doc(), target: document.activeElement?.getAttribute('aria-label') }
          setTimeout(() => { if (window.undoProbe) window.undoProbe.after = doc() })
        }, true)
        window.addEventListener('keyup', (event) => {
          if (event.key.toLowerCase() === 'z' && window.undoProbe) window.undoProbe.up = { at: performance.now(), doc: doc() }
        }, true)
      })
      await pressShortcut(app, process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
      const first = await page.evaluate(async () => {
        const seen = { down: !!window.undoProbe.down, up: !!window.undoProbe.up, at: performance.now() }
        await window.hibi.flushDocumentChanges()
        return { seen, markdown: (await window.hibi.getDocument()).markdown }
      })
      let settled = null
      const start = Date.now()
      while (Date.now() - start < 3000) {
        settled = (await acceptedInput(page)).markdown
        if (settled === source) break
        await new Promise((r) => setTimeout(r, 50))
      }
      const probe = await page.evaluate(() => window.undoProbe)
      const kind =
        first.markdown === source ? 'ok'
        : settled === source ? (first.seen.down ? 'late-after-key' : 'read-before-key')
        : 'never'
      counts[label + ' ' + kind] = (counts[label + ' ' + kind] ?? 0) + 1
      if (kind !== 'ok' || rep === 0)
        console.log('UNDOPROBE ' + JSON.stringify({ rep, label, kind, editedIsSource: edited === source, edited, first, settled, probe }))
    }
  console.log('UNDOPROBE-COUNTS ' + JSON.stringify(counts))
})

`
s = s.replace(anchor, probe + anchor)
writeFileSync(dir + '/tests/zz-undo-probe.test.mjs', s)
