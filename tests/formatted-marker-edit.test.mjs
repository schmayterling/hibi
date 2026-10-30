import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'

const cases = [
  ['emphasis', 'lead *word* tail', '*', 'word'],
  ['strong', 'lead **word** tail', '**', 'word'],
  ['strike', 'lead ~~word~~ tail', '~~', 'word'],
  ['inline code', 'lead ``word`` tail', '``', 'word'],
  ['highlight', 'lead ==word== tail', '==', 'word'],
  ['link brackets', 'lead [word](https://example.com) tail', '[', 'word'],
  [
    'link destination',
    'lead [word](https://example.com) tail',
    '](https://example.com)',
    'word',
  ],
  ['image', 'lead ![word](image.png) tail', '![', 'word'],
  ['inline math', 'lead $x+1$ tail', '$', 'x+1'],
  ['block math', '$$\nx+1\n$$', '$$', 'x+1'],
  ['heading', '### word', '### ', 'word'],
  ['bullet', '- word', '- ', 'word'],
  ['ordered list', '12. word', '12. ', 'word'],
  ['task', '- [ ] word', '[ ] ', 'word'],
  ['quote', '> word', '> ', 'word'],
  ['fence opening', '```js\nword\n```', '```js', 'word'],
  ['fence closing', '```js\nword\n```', '```', 'word', true],
  ['callout header', '> [!NOTE] word\n> body', '[!NOTE]', 'word'],
]

async function open(t, engine) {
  await mkdir(resolve('.scratch'), { recursive: true })
  const folder = await mkdtemp(resolve('.scratch/marker-edit-'))
  const file = resolve(folder, 'note.md')
  await writeFile(file, 'lead **word** tail\n\nend')
  await writeFile(
    resolve(folder, 'addons.json'),
    JSON.stringify({ math: true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${folder}`, file],
  })
  let cdp
  t.after(async () => {
    await cdp?.detach()
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, engine)
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  return { app, page, rich, cdp }
}

const state = (rich) =>
  rich.evaluate((element) => {
    const { state } = element.cmTile.root.view
    return {
      doc: state.doc.toString(),
      anchor: state.selection.main.anchor,
      head: state.selection.main.head,
    }
  })

async function select(rich, anchor, head = anchor) {
  await rich.evaluate(
    (element, { anchor, head }) => {
      const view = element.cmTile.root.view
      view.dispatch({ selection: { anchor, head }, scrollIntoView: true })
      view.focus()
    },
    { anchor, head },
  )
}

async function source(rich, doc, anchor) {
  await rich.evaluate(
    (element, { doc, anchor }) => {
      const view = element.cmTile.root.view
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        selection: { anchor },
        scrollIntoView: true,
      })
      view.focus()
    },
    { doc, anchor },
  )
  await rich.page().evaluate(() => new Promise(requestAnimationFrame))
}

/** Native pointer input, after scrolling and checking the actual hit target. */
async function clickAt(rich, pos, clickCount = 1) {
  const point = await rich.evaluate(
    (element, { pos, clickCount }) => {
      const view = element.cmTile.root.view
      const box = view.coordsAtPos(pos)
      if (!box) return null
      const next = clickCount > 1 ? view.coordsAtPos(pos + 1) : null
      const x = next ? box.left + (next.left - box.left) * 0.6 : box.left + 0.2
      const y = (box.top + box.bottom) / 2
      return { x, y, hit: element.contains(document.elementFromPoint(x, y)) }
    },
    { pos, clickCount },
  )
  assert.ok(point?.hit, `marker ${pos} is visible and hit-testable`)
  await rich.page().mouse.click(point.x, point.y, { clickCount })
}

test('codemirror: revealed markers are ordinary editable source', {
  timeout: 300000,
}, async (t) => {
  const { page, rich, cdp } = await open(t, 'codemirror')
  assert.equal(await page.locator('.rich-pane .tiptap').count(), 0)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (const [name, body, marker, word, last] of cases) {
    await t.test(name, async () => {
      const doc = `${body}\n\nend`
      const from = last ? body.lastIndexOf(marker) : body.indexOf(marker)
      const to = from + marker.length
      const reset = () => source(rich, doc, body.indexOf(word) + 1)
      await reset()
      assert.ok(
        (await rich.textContent()).includes(marker),
        'marker is revealed',
      )

      await select(rich, from)
      for (let head = from + 1; head <= to; head++) {
        await page.keyboard.press('ArrowRight')
        assert.equal(
          (await state(rich)).head,
          head,
          'right arrow visits every character',
        )
      }
      for (let head = to - 1; head >= from; head--) {
        await page.keyboard.press('ArrowLeft')
        assert.equal(
          (await state(rich)).head,
          head,
          'left arrow visits every character',
        )
      }
      await page.keyboard.press('Shift+ArrowRight')
      assert.deepEqual(await state(rich), { doc, anchor: from, head: from + 1 })
      assert.ok(
        (await rich.textContent()).includes(marker),
        'selected marker stays revealed',
      )

      await reset()
      await clickAt(rich, from + 1)
      assert.equal(
        (await state(rich)).head,
        from + 1,
        'click reaches inside marker',
      )
      await clickAt(rich, from, 2)
      const picked = await state(rich)
      assert.ok(
        picked.anchor !== picked.head,
        'double-click selects marker text',
      )
      assert.ok(Math.min(picked.anchor, picked.head) <= from)
      assert.ok(Math.max(picked.anchor, picked.head) >= from + 1)
      assert.ok(
        (await rich.textContent()).includes(marker),
        'double-clicked marker stays revealed',
      )

      await reset()
      await select(rich, to)
      await page.keyboard.press('Backspace')
      assert.deepEqual(
        await state(rich),
        {
          doc: doc.slice(0, to - 1) + doc.slice(to),
          anchor: to - 1,
          head: to - 1,
        },
        'backspace deletes one character',
      )

      await reset()
      await select(rich, from)
      await page.keyboard.press('Delete')
      assert.deepEqual(
        await state(rich),
        {
          doc: doc.slice(0, from) + doc.slice(from + 1),
          anchor: from,
          head: from,
        },
        'delete deletes one character',
      )
      const deleted = (await state(rich)).doc
      await page.keyboard.insertText('X')
      assert.deepEqual(
        await state(rich),
        {
          doc: `${deleted.slice(0, from)}X${deleted.slice(from)}`,
          anchor: from + 1,
          head: from + 1,
        },
        'typing after deletion keeps its source position',
      )

      await reset()
      await select(rich, from + 1)
      await page.keyboard.insertText('X')
      await page.evaluate(() => new Promise(requestAnimationFrame))
      assert.deepEqual(
        await state(rich),
        {
          doc: `${doc.slice(0, from + 1)}X${doc.slice(from + 1)}`,
          anchor: from + 2,
          head: from + 2,
        },
        'typing edits marker without moving caret',
      )
      assert.ok(
        (await rich.textContent()).includes('X'),
        'edited text stays visible',
      )
    })
  }
  await t.test(
    'editing a revealed link destination keeps the label and caret',
    async () => {
      const doc = 'lead [word](https://example.com) tail'
      const from = doc.indexOf('example')
      await source(rich, doc, doc.indexOf('word'))
      await select(rich, from, from + 'example'.length)
      await page.keyboard.insertText('edited')
      assert.deepEqual(await state(rich), {
        doc: 'lead [word](https://edited.com) tail',
        anchor: from + 6,
        head: from + 6,
      })
      assert.ok((await rich.textContent()).includes('https://edited.com'))
    },
  )
  await t.test(
    'change delimiter spelling and reparse nested formatting',
    async () => {
      await source(rich, 'lead **word** tail', 8)
      await select(rich, 5, 7)
      await page.keyboard.insertText('__')
      await select(rich, 11, 13)
      await page.keyboard.insertText('__')
      assert.equal((await state(rich)).doc, 'lead __word__ tail')
      assert.equal(
        await rich.locator('.hibi-lp-strong').textContent(),
        '__word__',
      )
      await select(rich, 6)
      await page.keyboard.insertText('_')
      await select(rich, 13)
      await page.keyboard.insertText('_')
      assert.equal((await state(rich)).doc, 'lead ___word___ tail')
      assert.ok(
        await rich
          .locator('.hibi-lp-em .hibi-lp-strong, .hibi-lp-strong .hibi-lp-em')
          .count(),
      )
    },
  )
  await t.test(
    'adding a third star reparses emphasis without moving the caret',
    async () => {
      await source(rich, 'lead **word** tail', 8)
      await select(rich, 6)
      await page.keyboard.insertText('*')
      assert.equal((await state(rich)).head, 7)
      await select(rich, 13)
      await page.keyboard.insertText('*')
      assert.deepEqual(await state(rich), {
        doc: 'lead ***word*** tail',
        anchor: 14,
        head: 14,
      })
      assert.ok(await rich.locator('.hibi-lp-em').count())
      assert.ok(await rich.locator('.hibi-lp-strong').count())
    },
  )
  await t.test(
    'prefix selections keep their block revealed until they cross blocks',
    async () => {
      const doc = '> **word**\n> next\n\nend'
      await source(rich, doc, 5)
      await select(rich, 0, doc.indexOf('next') + 4)
      assert.ok((await rich.textContent()).includes('**word**'))
      assert.ok((await rich.textContent()).startsWith('> '))
      await select(rich, 0, doc.length)
      assert.equal(await rich.locator('.hibi-lp-marker').count(), 0)
    },
  )
  await t.test('revealed task source keeps its checkbox operable', async () => {
    await source(rich, '- [ ] word', 8)
    await rich.locator('.hibi-lp-task').click()
    assert.equal((await state(rich)).doc, '- [x] word')
    assert.equal(await rich.locator('.hibi-lp-task').isChecked(), true)
  })
  await t.test(
    'a revealed task keeps its focused checkbox for the keyboard',
    async () => {
      await source(rich, '- [ ] buy milk\n- [x] done', 9)
      assert.ok((await rich.textContent()).startsWith('- [ ] buy milk'))
      await rich.locator('.hibi-lp-task').first().focus()
      await page.evaluate(() => new Promise(requestAnimationFrame))
      assert.ok(
        await page.evaluate(() =>
          document.activeElement?.classList.contains('hibi-lp-task'),
        ),
      )
      await page.keyboard.press('Space')
      assert.equal((await state(rich)).doc, '- [x] buy milk\n- [x] done')
      // Focus leaving the editor from the checkbox hides the source again.
      await page.evaluate(() => document.activeElement.blur())
      await page.evaluate(() => new Promise(requestAnimationFrame))
      assert.equal(await rich.locator('.hibi-lp-marker').count(), 0)
    },
  )
  await t.test(
    'a table cell edits revealed delimiters character by character',
    async () => {
      const doc = '| head | other |\n| --- | --- |\n| **word** | plain |'
      await source(rich, doc, doc.length)
      await rich.locator('.hibi-lp-table td').first().click()
      const cell = page.locator('.hibi-lp-cell-editor .cm-content')
      await cell.waitFor()
      const before = (await state(cell)).doc
      const from = before.indexOf('**')
      await select(cell, from + 2)
      await page.keyboard.press('ArrowLeft')
      assert.equal((await state(cell)).head, from + 1)
      await page.keyboard.press('Backspace')
      assert.equal(
        (await state(cell)).doc,
        before.slice(0, from) + before.slice(from + 1),
      )
      assert.equal((await state(cell)).head, from)
      assert.ok((await state(rich)).doc.includes('*word**'))
    },
  )
  // The first click of a double-click puts the caret in the block, which
  // shows its syntax and moves the text under the pointer.
  for (const [name, doc, word] of [
    ['code', 'para\n\n```js\nalpha beta\ngamma delta\n```', 'delta'],
    ['task', 'para\n\n- [ ] alpha beta', 'alpha'],
    ['quote', 'para\n\n> alpha beta', 'alpha'],
    ['heading', 'para\n\n## alpha beta', 'alpha'],
    ['emphasis', 'para\n\nx **bold** alpha', 'alpha'],
  ])
    await t.test(
      `a double-click selects the word its first click hit: ${name}`,
      async () => {
        await source(rich, `${doc}\n\nend`, 2)
        const at = doc.indexOf(word) + 1
        const point = await rich.evaluate((element, at) => {
          const view = element.cmTile.root.view
          const a = view.coordsAtPos(at, 1)
          const b = view.coordsAtPos(at + 1, -1)
          const x = (a.left + b.left) / 2
          const y = (a.top + a.bottom) / 2
          return { x, y, hit: view.posAtCoords({ x, y }) }
        }, at)
        assert.ok(point.hit === at || point.hit === at + 1)
        await page.mouse.dblclick(point.x, point.y)
        const { doc: text, anchor, head } = await state(rich)
        assert.equal(
          text.slice(Math.min(anchor, head), Math.max(anchor, head)),
          word,
        )
      },
    )
  await t.test(
    'vertical arrows keep the caret column as prefixes show',
    async () => {
      for (const doc of [
        '- hello\n- world\n- again',
        '12. hello\n13. world\n14. again',
        '- [ ] hello\n- [ ] world\n- [ ] again',
        '> hello\n>\n> world',
      ]) {
        const start = doc.indexOf('hello') + 3
        await source(rich, `${doc}\n\nend`, start)
        const goal = await rich.evaluate(
          (element, start) => element.cmTile.root.view.coordsAtPos(start).left,
          start,
        )
        for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp']) {
          await page.keyboard.press(key)
          // No other position on the line is nearer the starting column.
          const off = await rich.evaluate((element, goal) => {
            const { view } = element.cmTile.root
            const { head } = view.state.selection.main
            const line = view.state.doc.lineAt(head)
            const off = (pos) =>
              pos < line.from || pos > line.to
                ? Number.POSITIVE_INFINITY
                : Math.abs(view.coordsAtPos(pos).left - goal)
            return line.length > 3
              ? [off(head - 1), off(head), off(head + 1)]
              : [1, 0, 1]
          }, goal)
          assert.ok(
            off[1] <= Math.min(off[0], off[2]) + 0.5,
            `${doc}: ${key} ${off}`,
          )
        }
        assert.equal((await state(rich)).head, start, doc)
      }
    },
  )
  // An input method's text replaces its earlier candidates even where it
  // turns the block into another, which moves its line out of a heading.
  for (const [name, doc, at] of [
    ['heading', '## word', 1],
    ['link', 'lead [word](https://example.com) tail', 11],
    ['fence', '```js\nword\n```', 1],
    ['bullet', '- word', 1],
    ['strong', 'lead **word** tail', 6],
  ])
    await t.test(`composition inside revealed markers: ${name}`, async () => {
      await source(rich, `${doc}\n\nend`, at)
      for (const text of ['k', 'か'])
        await cdp.send('Input.imeSetComposition', {
          text,
          selectionStart: 1,
          selectionEnd: 1,
        })
      await cdp.send('Input.insertText', { text: 'か' })
      await page.evaluate(() => new Promise(requestAnimationFrame))
      assert.deepEqual(await state(rich), {
        doc: `${doc.slice(0, at)}か${doc.slice(at)}\n\nend`,
        anchor: at + 1,
        head: at + 1,
      })
    })
  await t.test(
    'a quoted paragraph shows no prefix inside its flowed lines',
    async () => {
      const doc = '> hello\n> world'
      await source(rich, `${doc}\n\nend`, 5)
      const heads = []
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('ArrowRight')
        heads.push((await state(rich)).head)
        assert.equal(
          await rich.locator('.cm-line').first().textContent(),
          heads.at(-1) < 8 ? '> hello world' : 'hello world',
        )
      }
      assert.deepEqual(heads, [6, 7, 10, 11, 12])
    },
  )
  await t.test(
    'hidden runs and fence lines keep their atomic navigation',
    async () => {
      await page.evaluate(() =>
        localStorage.setItem('markdown-markers', 'false'),
      )
      await page.reload()
      const rich = page.getByRole('textbox', {
        name: 'Document editor',
        exact: true,
      })
      await rich.waitFor()
      await source(rich, 'lead ***word*** tail', 12)
      assert.equal(await rich.locator('.hibi-lp-marker').count(), 0)
      await page.keyboard.press('ArrowRight')
      assert.equal((await state(rich)).head, 16)
      await select(rich, 8)
      await page.keyboard.press('ArrowLeft')
      assert.equal((await state(rich)).head, 4)

      const doc = '```js\ncode\n```\n\nnext'
      await source(rich, doc, doc.indexOf('code') + 4)
      await page.keyboard.press('ArrowRight')
      assert.equal((await state(rich)).head, doc.indexOf('next'))
      await source(rich, '- [ ] task', 8)
      assert.equal(await rich.locator('.hibi-lp-task').count(), 1)
      assert.equal(await rich.locator('.hibi-lp-marker').count(), 0)
    },
  )
  assert.deepEqual(errors, [])
})

test('tiptap: formatting hints remain generated noneditable markers (accepted difference)', {
  timeout: 90000,
}, async (t) => {
  const { page, rich } = await open(t, 'tiptap')
  assert.equal(await page.locator('.rich-pane .hibi-formatted').count(), 0)
  await rich.locator('strong').click()
  const hints = rich.locator('.markdown-marker')
  await hints.first().waitFor()
  assert.equal(await hints.count(), 2)
  assert.deepEqual(
    await hints.evaluateAll((markers) =>
      markers.map((marker) => ({
        text: marker.textContent,
        hint: marker.getAttribute('data-marker'),
        editable: marker.getAttribute('contenteditable'),
      })),
    ),
    [
      { text: '', hint: '**', editable: 'false' },
      { text: '', hint: '**', editable: 'false' },
    ],
  )
  assert.equal(await rich.textContent(), 'lead word tailend')
})
