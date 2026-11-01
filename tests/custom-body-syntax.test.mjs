import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  waitForDocumentEditor,
  waitForFormattedEditor,
} from './electron.mjs'
import {
  customBodyBoldCases,
  customBodyCases,
} from './fixtures/custom-body.mjs'
import { clickMenu } from './keyboard.mjs'

const cases = [
  {
    feature: 'core.italic',
    bodies: [
      ['> [!TIP]\n> *careful*', 'careful'],
      ['-# small *words*', 'small words'],
    ],
  },
  {
    feature: 'markdown.strike',
    bodies: [
      ['> [!TIP]\n> ~~gone~~', 'gone'],
      ['-# small ~~words~~', 'small words'],
    ],
  },
  {
    feature: 'core.links',
    bodies: [
      ['> [!TIP]\n> [a](https://b.test)', 'a'],
      ['-# small [a](https://b.test)', 'small a'],
    ],
  },
  {
    feature: 'core.heading-1',
    bodies: [['> [!TIP]\n> # head', 'head']],
  },
]

test('custom body preference scopes match native text', {
  timeout: 180000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-custom-body-'))
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'text-extras': true, markdown: true, 'word-count': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await waitForFormattedEditor(app, page)
  // Segment fixed fixture text with the editor's ICU version, which may differ from Node.
  const count = (text) =>
    page.evaluate(
      (text) => ({
        words: [
          ...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(
            text,
          ),
        ].filter((part) => part.isWordLike).length,
        characters: [
          ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
            text,
          ),
        ].length,
      }),
      text,
    )
  let index = 0
  const render = async (feature, source, counted) => {
    await page.evaluate((feature) => {
      localStorage.setItem(
        'hibi:markdown-syntax-disabled',
        JSON.stringify(feature ? [feature] : []),
      )
    }, feature)
    await page.reload()
    await waitForDocumentEditor(app, page)
    const file = join(profile, `body-${index++}.md`)
    await writeFile(file, `${source}\n\ntail`)
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await waitForDocumentEditor(app, page)
    await page.waitForFunction(
      async (source) => (await window.hibi.getDocument()).markdown === source,
      `${source}\n\ntail`,
    )
    if (counted !== undefined) {
      const totals = await count(`${counted}\ntail`)
      const expected = `${totals.words} words · ${totals.characters} characters`
      await page.waitForFunction(
        (label) =>
          document.querySelector('[data-status-id="word-count.total"]')
            ?.textContent === label,
        expected,
      )
    }
    const editor = page.getByRole('textbox', {
      name: 'Document editor',
      exact: true,
    })
    return editor.evaluate((element) => {
      const view = element.cmTile.root.view
      view.dispatch({ selection: { anchor: view.state.doc.length } })
      element.blur()
      return new Promise((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const parts = []
            for (const child of element.children) {
              if (child.classList.contains('hibi-lp-alert-title')) continue
              let text = child.innerText ?? ''
              for (const marker of child.querySelectorAll(
                '.hibi-lp-list-marker',
              ))
                text = text.replace(marker.innerText, '')
              parts.push(text)
            }
            const text = parts.join(' ')
            resolve(text.replace(/\s+/g, ' ').trim())
          }),
        ),
      )
    })
  }

  for (const entry of cases)
    await t.test(entry.feature, async () => {
      for (const [source, text] of entry.bodies)
        assert.equal(
          await render(entry.feature, source),
          `${text} tail`,
          source,
        )
    })

  for (const [name, source, expected] of [
    ['bullet alert', '- > [!TIP]\n  > **x**', '**x** tail'],
    ['ordered alert', '1. > [!TIP]\n   > **x**', '**x** tail'],
    ['list subtext', '- -# small **words**', 'small words tail'],
  ])
    await t.test(name, async () => {
      assert.equal(await render('core.bold', source), expected)
    })
  for (const fixture of customBodyBoldCases)
    await t.test(`nested bold scope: ${fixture.name}`, async () => {
      assert.equal(
        await render('core.bold', fixture.source, fixture.text),
        `${fixture.text}\n\ntail`.replace(/\s+/g, ' ').trim(),
        fixture.source,
      )
      assert.equal(
        await page
          .locator('.rich-pane .hibi-lp-strong, .rich-pane strong')
          .count(),
        0,
      )
    })

  for (const fixture of customBodyCases)
    await t.test(
      `model, renderer, count and undo: ${fixture.name}`,
      async () => {
        assert.equal(
          await render(fixture.feature, fixture.source, fixture.text),
          `${fixture.text}\n\ntail`.replace(/\s+/g, ' ').trim(),
        )
        const pane = page.locator('.rich-pane')
        const styled =
          fixture.feature === 'core.heading-1'
            ? '.hibi-lp-h2, h2'
            : fixture.name === 'subscript bold'
              ? '.hibi-lp-subscript, sub'
              : null
        if (styled) assert.ok(await pane.locator(styled).count(), fixture.name)
        if (fixture.feature === 'markdown.strike')
          assert.equal(await pane.locator('.hibi-lp-strike, s').count(), 0)
        if (fixture.feature === 'core.italic')
          assert.equal(await pane.locator('.hibi-lp-em, em').count(), 0)
        if (fixture.feature === 'core.links')
          assert.equal(await pane.locator('.hibi-lp-link, a').count(), 0)
        if (fixture.feature === 'core.bold' || fixture.name === 'bullet alert')
          assert.equal(await pane.locator('.hibi-lp-strong, strong').count(), 0)
        if (fixture.name === 'ordered alert')
          assert.ok(await pane.locator('.hibi-lp-strong, strong').count())
        if (fixture.name === 'alert task')
          assert.equal(await pane.locator('input[type="checkbox"]').count(), 1)
        const editor = page.getByRole('textbox', {
          name: 'Document editor',
          exact: true,
        })
        await editor.focus()
        await page.keyboard.insertText(' proof')
        const modified = `${fixture.source}\n\ntail proof`
        await page.waitForFunction(
          async (source) =>
            (await window.hibi.getDocument()).markdown === source,
          modified,
        )
        const total = await count(`${fixture.text}\ntail proof`)
        await page.waitForFunction(
          (expected) =>
            document.querySelector('[data-status-id="word-count.total"]')
              ?.textContent === expected,
          `${total.words} words · ${total.characters} characters`,
        )
        await editor.press(
          `${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`,
        )
        await page.waitForFunction(
          async (source) =>
            (await window.hibi.getDocument()).markdown === source,
          `${fixture.source}\n\ntail`,
        )
        const restored = await count(`${fixture.text}\ntail`)
        await page.waitForFunction(
          (expected) =>
            document.querySelector('[data-status-id="word-count.total"]')
              ?.textContent === expected,
          `${restored.words} words · ${restored.characters} characters`,
        )
      },
    )

  await t.test(
    'task items keep their native body and count scope',
    async () => {
      assert.equal(
        await render('core.bold', '> [!TIP]\n> - [ ] **x** y', '\n\n\nx y'),
        'x y tail',
      )
    },
  )
  await t.test(
    'table cell editors preserve scope with markers shown or hidden',
    async () => {
      const fixture = customBodyBoldCases.find(
        (entry) => entry.name === 'table / bold',
      )
      assert.ok(fixture)
      try {
        for (const markers of [true, false]) {
          await page.evaluate(
            (shown) => localStorage.setItem('markdown-markers', String(shown)),
            markers,
          )
          await render('core.bold', fixture.source, fixture.text)
          await page.locator('.rich-pane td').first().click()
          const cell = page.getByRole('textbox', {
            name: 'Table cell',
            exact: true,
          })
          await cell.evaluate((element) => {
            const view = element.cmTile.root.view
            view.dispatch({ selection: { anchor: view.state.doc.length } })
          })
          const expected = markers ? '**x**' : 'x'
          await page
            .waitForFunction(
              (text) =>
                document
                  .querySelector('.hibi-lp-cell-editor .cm-content')
                  ?.innerText.trim() === text,
              expected,
            )
            .catch((error) => {
              if (error.name !== 'TimeoutError') throw error
            })
          assert.equal((await cell.innerText()).trim(), expected)
          assert.equal(await cell.locator('.hibi-lp-strong').count(), 0)
          assert.match(
            await cell.evaluate((element) =>
              element.cmTile.root.view.state.doc.toString(),
            ),
            /\*\*x\*\*/,
          )
        }
      } finally {
        await page.evaluate(() => localStorage.removeItem('markdown-markers'))
      }
    },
  )

  for (const [name, feature, source, text] of [
    [
      'native task item in alert',
      'core.bold',
      '> [!TIP]\n> - [ ] **x** y',
      '\n\n\nx y',
    ],
    [
      'native alert in bullet item',
      '',
      '- > [!TIP]\n  > **x** y',
      '\n\n**x** y',
    ],
    [
      'native alert in ordered item',
      '',
      '1. > [!TIP]\n   > **x** y',
      '\n\n\n\n\n\nx y',
    ],
  ])
    await t.test(name, async () => {
      assert.equal(
        await render(feature, source, text),
        `${text}\ntail`.replace(/\s+/g, ' ').trim(),
        source,
      )
    })
})
