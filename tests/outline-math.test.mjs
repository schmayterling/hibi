import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines,
} from './formatted-engine.mjs'
import { clickMenu } from './keyboard.mjs'

const note = `# Taylor $f(x,y)\\in C^{k+1}$ near $(a,b)$

text

## $P_{k,(a,b)}(x,y) + R_{k,(a,b)}(x,y)$

text

## Broken $\\notamacro x$ stays

text

## Plain heading
`
const labels = [
  'Taylor f(x,y)\\in C^{k+1} near (a,b)',
  'P_{k,(a,b)}(x,y) + R_{k,(a,b)}(x,y)',
  'Broken \\notamacro x stays',
  'Plain heading',
]

testFormattedEngines(
  'outline labels render heading math with KaTeX and keep LaTeX when it cannot',
  {
    timeout: 60000,
  },
  async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-outline-math-'))
    const file = join(profile, 'outline.md')
    await writeFile(
      join(profile, 'addons.json'),
      JSON.stringify({ math: true }),
    )
    await writeFile(file, note)
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
    page.setDefaultTimeout(15000)
    await page.setViewportSize({ width: 1100, height: 800 })
    await selectFormattedEngine(app, page, t.formattedEngine)
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await waitForDocumentEditor(app, page)
    await page.getByRole('button', { name: /^toggle right sidebar$/i }).click()
    await page.getByRole('button', { name: /^right sidebar views$/i }).click()
    await page
      .getByRole('menuitem', { name: 'On this page', exact: true })
      .click()
    const rows = (prefix) =>
      page.evaluate((prefix) => {
        const rows = [
          ...document.querySelectorAll(
            `.outline-sidebar[data-side="right"][data-open="true"] [role="treeitem"]${prefix}`,
          ),
        ]
        return rows.map((row) => {
          const label = row.querySelector('.sidebar-label')
          const formulas = [...label.querySelectorAll('.outline-math')]
          return {
            tooltip: row.dataset.tooltip,
            rendered: formulas.map(
              (formula) => !!formula.querySelector('.katex'),
            ),
            plain: formulas
              .filter((formula) => !formula.querySelector('.katex'))
              .map((formula) => formula.textContent),
            // KaTeX output fits its row instead of spilling into the next one.
            fits: [...label.querySelectorAll('.katex-html')].every((html) => {
              const box = html.getBoundingClientRect(),
                outer = row.getBoundingClientRect()
              return box.height > 0 && box.height <= outer.height
            }),
          }
        })
      }, prefix)
    const expected = [
      { tooltip: labels[0], rendered: [true, true], plain: [], fits: true },
      { tooltip: labels[1], rendered: [true], plain: [], fits: true },
      {
        tooltip: labels[2],
        rendered: [false],
        plain: ['\\notamacro x'],
        fits: true,
      },
      { tooltip: labels[3], rendered: [], plain: [], fits: true },
    ]
    const expectRows = async (prefix) => {
      await page
        .waitForFunction(
          ({ prefix, count }) =>
            document.querySelectorAll(
              `.outline-sidebar[data-side="right"][data-open="true"] [role="treeitem"]${prefix} .outline-math .katex`,
            ).length === count,
          { prefix, count: 3 },
        )
        .catch(async (cause) => {
          throw new Error(JSON.stringify(await rows(prefix)), { cause })
        })
      assert.deepEqual(await rows(prefix), expected)
    }
    await expectRows('')
    await page.getByRole('button', { name: /^source view$/i }).click()
    await page
      .getByRole('textbox', { name: 'Markdown editor', exact: true })
      .waitFor()
    await expectRows('[id^="right-outline-source:"]')
  },
)
