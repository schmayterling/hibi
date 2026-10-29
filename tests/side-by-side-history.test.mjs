import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu, pressShortcut, withHeldClock } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const redo = process.platform === 'win32' ? 'Control+y' : `${mod}+Shift+z`
const source = 'alpha bravo charlie\n'

// Both panes edit one session history. Typing joins only the last edit of the
// same pane: an edit in the other pane is a caret somewhere else, like a
// selection move, so each pane's typing is its own step and comes back with
// that pane's selection. Steps are [pane, position, text, focus?].
const scenarios = [
  {
    name: 'one pane joins adjacent typing',
    steps: [
      ['source', 1, 'X'],
      ['source', 2, 'Y'],
    ],
    groups: [[0, 1]],
  },
  {
    name: 'adjacent typing in the other pane without focus',
    steps: [
      ['source', 1, 'X'],
      ['rich', 2, 'Y'],
    ],
    groups: [[0], [1]],
  },
  {
    name: 'distant typing in the other pane without focus',
    steps: [
      ['rich', 1, 'X'],
      ['source', 15, 'Y'],
    ],
    groups: [[0], [1]],
  },
  {
    name: 'a pane resuming next to its own edit after the other pane typed',
    steps: [
      ['source', 1, 'X'],
      ['rich', 16, 'Y'],
      ['source', 2, 'Z'],
    ],
    groups: [[0], [1], [2]],
  },
  {
    name: 'adjacent typing as focus moves between panes',
    steps: [
      ['rich', 1, 'X', true],
      ['source', 2, 'Y', true],
      ['rich', 3, 'Z', true],
    ],
    groups: [[0], [1], [2]],
  },
  {
    name: 'distant typing as focus moves between panes',
    steps: [
      ['source', 1, 'X', true],
      ['rich', 15, 'Y', true],
    ],
    groups: [[0], [1]],
  },
]

test('side-by-side panes keep their own undo steps and selections', {
  timeout: 180000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-side-history-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, 'codemirror')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const markdown = () =>
    page.evaluate(async () => {
      await window.hibi.flushDocumentChanges()
      return (await window.hibi.getDocument()).markdown
    })
  // Both panes show the session's text; each pane's selection in source units.
  const state = () =>
    waitForAsync(page, async () => {
      await window.hibi.flushDocumentChanges()
      const text = (await window.hibi.getDocument()).markdown
      const views = ['source', 'rich'].map(
        (pane) =>
          document.querySelector(`.${pane}-pane .cm-content`).cmTile.root.view,
      )
      return views.every((view) => view.state.doc.toString() === text)
    }).then(() =>
      page.evaluate(async () => {
        const pane = (name) => {
          const { main } = document.querySelector(`.${name}-pane .cm-content`)
            .cmTile.root.view.state.selection
          return [main.anchor, main.head]
        }
        return {
          text: (await window.hibi.getDocument()).markdown,
          source: pane('source'),
          rich: pane('rich'),
        }
      }),
    )
  for (const [index, item] of scenarios.entries())
    await t.test(item.name, async () => {
      const file = join(profile, `note-${index}.md`)
      await writeFile(file, source)
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        })
      }, file)
      await clickMenu(app, 'Open…')
      await waitForAsync(
        page,
        async (name) => (await window.hibi.getDocument()).name === name,
        `note-${index}.md`,
      )
      await waitForDocumentEditor(app, page)
      if (!(await page.locator('.mode-side-by-side').count()))
        await page
          .getByRole('button', { name: /^side-by-side$/i, exact: true })
          .click()
      await page
        .locator('.mode-side-by-side[data-source-ready="true"]')
        .waitFor()
      // Unfocused edits start from carets each pane already has.
      await page.evaluate(() => {
        for (const [pane, anchor] of [
          ['source', 0],
          ['rich', 0],
        ])
          document
            .querySelector(`.${pane}-pane .cm-content`)
            .cmTile.root.view.dispatch({ selection: { anchor } })
        document.querySelector('.source-pane .cm-content').focus()
      })
      // Each step's state as its edit starts and as it leaves it.
      const before = [],
        after = []
      // Keys within the grouping window, however slow the machine.
      await withHeldClock(page, async () => {
        for (const [pane, at, text, focus] of item.steps) {
          if (focus) {
            await page.evaluate(
              ({ pane, at }) => {
                const { view } = document.querySelector(
                  `.${pane}-pane .cm-content`,
                ).cmTile.root
                view.focus()
                view.dispatch({ selection: { anchor: at } })
              },
              { pane, at },
            )
            before.push(await state())
            await page.keyboard.type(text)
          } else {
            before.push(await state())
            await page.evaluate(
              ({ pane, at, text }) =>
                document
                  .querySelector(`.${pane}-pane .cm-content`)
                  .cmTile.root.view.dispatch({
                    changes: { from: at, insert: text },
                    userEvent: 'input.type',
                  }),
              { pane, at, text },
            )
          }
          after.push(await state())
        }
      })
      // Undo returns to the text its group started from, with the editing
      // pane's selection from then; redo to where the group left both.
      for (const group of [...item.groups].reverse()) {
        await pressShortcut(app, `${mod}+z`)
        const expected = before[group[0]],
          pane = item.steps[group[0]][0],
          now = await state()
        assert.equal(now.text, expected.text, `undo ${group}`)
        assert.deepEqual(now[pane], expected[pane], `undo ${group} ${pane}`)
      }
      assert.equal(await markdown(), source)
      for (const group of item.groups) {
        await pressShortcut(app, redo)
        const expected = after[group.at(-1)],
          pane = item.steps[group.at(-1)][0],
          now = await state()
        assert.equal(now.text, expected.text, `redo ${group}`)
        assert.deepEqual(now[pane], expected[pane], `redo ${group} ${pane}`)
      }
    })
})
