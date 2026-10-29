import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after } from 'node:test'
import { Editor } from '@tiptap/core'
import { Image } from '@tiptap/extension-image'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import { Markdown } from '@tiptap/markdown'
import { NativeTableKit } from '../src/addons/markdown/table-tokenizer.ts'
import { mathFlavor, mathTokens } from '../src/addons/math/syntax.ts'
import { markdownConfiguration } from '../src/renderer/src/markdown.ts'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines,
} from './formatted-engine.mjs'
import { clickMenu } from './keyboard.mjs'

const atoms = {
  divider: '---',
  image: '![old](pic.png)',
  math: '$$\nx^2\n$$',
  html: '<div>\nlast\n</div>',
  comment: '<!-- last -->',
  mermaid: '```mermaid\ngraph TD\n  A --> B\n```',
  typst: '```typst\n= last\n```',
}
const containers = {
  document: (block) => `plain\n\n${block}\n`,
  list: (block) => `plain\n\n- item\n\n  ${block.replaceAll('\n', '\n  ')}\n`,
  quote: (block) =>
    `plain\n\n> quoted\n>\n> ${block.replaceAll('\n', '\n> ')}\n`,
}
const ordered = (block) =>
  `plain\n\n1. item\n\n   ${block.replaceAll('\n', '\n   ')}\n`
const actions = [
  'image',
  'quote',
  'divider',
  'bullet-list',
  'numbered-list',
  'checklist',
  'outdent',
  'table',
  'bold',
  'heading-1',
  'paragraph',
  'code-block',
  'hard-break',
  'unlink',
  'indent',
]
const native = new Map()
const mathExtensions = [InlineMath, BlockMath].map((extension) => {
  const syntax = mathTokens.extensions.find(
    ({ name }) => name === extension.name,
  )
  return extension.extend({
    markdownTokenizer: {
      name: syntax.name,
      level: syntax.level,
      start: syntax.start,
      tokenize: syntax.tokenizer,
    },
  })
})
const configuration = markdownConfiguration([
  {
    id: 'markdown',
    markedOptions: { gfm: true },
    richExtensions: [
      Image,
      NativeTableKit,
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
  },
  {
    ...mathFlavor,
    richExtensions: mathExtensions,
    export: { extensions: [mathTokens] },
  },
])
const oracle = new Editor({
  element: null,
  content: 'seed',
  contentType: 'markdown',
  extensions: [
    ...configuration.core,
    Markdown.configure({
      marked: configuration.parser,
      markedOptions: configuration.options,
    }),
    ...configuration.addons,
  ],
})
after(() => oracle.destroy())
const parse = (source) => {
  oracle.commands.setContent(source, { contentType: 'markdown' })
  return oracle.getJSON()
}
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

function toolbar() {
  return [
    ...document.querySelectorAll(
      '.editor-toolbar [data-toolbar-id^="format."]',
    ),
  ]
    .filter(
      (button) => !['undo', 'redo'].includes(button.dataset.toolbarId.slice(7)),
    )
    .map((button) => [
      button.dataset.toolbarId.slice(7),
      !button.disabled,
      button.getAttribute('aria-pressed') === 'true',
    ])
}

async function snapshot(page) {
  return page.evaluate(async () => {
    await window.hibi.flushDocumentChanges()
    const root = document.querySelector(
      '.rich-pane [aria-label="Document editor"]',
    )
    const state = root.editor?.state
    const range = root.cmTile?.root.view.state.selection.main
    const source = (await window.hibi.getDocument()).markdown
    return {
      source: source.replace(/assets\/pic(?:-\d+)?\.png/g, 'assets/pic.png'),
      selected: state
        ? state.selection.toJSON().type === 'node'
        : range.from !== range.to,
    }
  })
}

testFormattedEngines(
  'toolbar actions on selected atoms preserve their containers',
  {
    timeout: 600000,
  },
  async (t) => {
    const engine = t.formattedEngine
    const folder = await mkdtemp(join(tmpdir(), 'hibi-atom-actions-'))
    const profile = join(folder, 'profile')
    await mkdir(profile)
    await writeFile(
      join(profile, 'addons.json'),
      JSON.stringify({ math: true, typst: true }),
    )
    const png = join(folder, 'pic.png')
    await writeFile(
      png,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    )
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    t.after(async () => {
      await app.close()
      await rm(folder, { recursive: true, force: true })
    })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    await selectFormattedEngine(app, page, engine)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    let count = 0
    async function open(source, atom = true) {
      const name = `atom-${count++}.md`
      const file = join(folder, name)
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
        name,
      )
      await waitForDocumentEditor(app, page)
      await page.locator('.rich-pane [aria-label="Document editor"]').focus()
      await page.waitForFunction(() =>
        document
          .querySelector('.rich-pane [aria-label="Document editor"]')
          ?.contains(document.activeElement),
      )
      if (atom)
        await page.waitForFunction(() => {
          const root = document.querySelector(
            '.rich-pane [aria-label="Document editor"]',
          )
          const selection = root.editor?.state.selection
          const range = root.cmTile?.root.view.state.selection.main
          return selection
            ? selection.toJSON().type === 'node'
            : range && !range.empty
        })
      await page.evaluate(async () => {
        for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame)
      })
    }
    const compare = (key, value) => {
      // Match document structure; each engine may spell padding and blank lines differently.
      if (value.source !== undefined) {
        value = { document: parse(value.source), selected: value.selected }
      }
      if (engine === 'tiptap') native.set(key, value)
      else assert.deepEqual(value, native.get(key), key)
    }
    const table =
      'plain\n\n| aa   | bb   |\n| ---- | ---- |\n| cell |      |\n| next | tail |\n\nafter\n'
    for (const [name, start, keys, target, text] of [
      ['forward filled', 0, ['Tab'], 1, 'bb'],
      ['backward filled', 5, ['Shift+Tab'], 4, 'next'],
      ['forward empty', 2, ['Tab'], 3, ''],
      ['backward empty', 4, ['Shift+Tab'], 3, ''],
      ['forward row wrap', 1, ['Tab'], 2, 'cell'],
      ['backward row wrap', 2, ['Shift+Tab'], 1, 'bb'],
      ['add row', 5, ['Tab'], 6, ''],
      ['back from added row', 5, ['Tab', 'Shift+Tab'], 5, 'tail'],
    ])
      await t.test(`tab: ${name}`, async () => {
        await open(table, false)
        const cells = page.locator('.rich-pane th, .rich-pane td')
        const cell = cells.nth(start)
        await cell.scrollIntoViewIfNeeded()
        await cell.click()
        // The rich editor reads a click's DOM caret on selectionchange.
        await page.waitForFunction((start) => {
          const root = document.querySelector(
            '.rich-pane [aria-label="Document editor"]',
          )
          const cell = [
            ...document.querySelectorAll('.rich-pane th, .rich-pane td'),
          ][start]
          if (root.editor) {
            const { selection } = root.editor.state
            return (
              selection.empty &&
              cell.contains(root.editor.view.domAtPos(selection.head).node)
            )
          }
          return cell.contains(document.activeElement)
        }, start)
        for (const key of keys) await page.keyboard.press(key)
        await page.waitForFunction(
          ({ target, text }) => {
            const cell = [
              ...document.querySelectorAll('.rich-pane th, .rich-pane td'),
            ][target]
            const selected = getSelection()
            return (
              cell?.contains(selected.focusNode) &&
              selected.toString().trim() === text
            )
          },
          { target, text },
        )
        await page.keyboard.type('Y')
        await waitForAsync(page, async () =>
          (await window.hibi.getDocument()).markdown.includes('Y'),
        )
        const result = await cells.evaluateAll((cells) =>
          cells.map((cell) => cell.textContent.trim()),
        )
        const expected = ['aa', 'bb', 'cell', '', 'next', 'tail']
        if (keys[0] === 'Tab' && start === 5) expected.push('', '')
        expected[target] = 'Y'
        assert.deepEqual(result, expected, name)
        compare(`tab: ${name}`, result)
      })
    for (const [container, wrap] of Object.entries(containers))
      for (const [kind, block] of Object.entries(atoms)) {
        const source = wrap(block)
        const name = `${container} ${kind}`
        await t.test(`${name}: toolbar`, async () => {
          await open(source)
          compare(`${name}: toolbar`, await page.evaluate(toolbar))
        })
        for (const action of actions)
          await t.test(`${name}: ${action}`, async () => {
            await open(source)
            if (action === 'image')
              await app.evaluate(({ dialog }, png) => {
                dialog.showOpenDialog = async () => ({
                  canceled: false,
                  filePaths: [png],
                })
              }, png)
            const button = page.locator(
              `.editor-toolbar [data-toolbar-id="format.${action}"]`,
            )
            // Exercise command guards too. Restore React's last written disabled state.
            await button.evaluate((button) => {
              const disabled = button.disabled
              button.disabled = false
              button.click()
              button.disabled = disabled
            })
            if (action === 'image')
              await waitForAsync(page, async () =>
                (await window.hibi.getDocument()).markdown.includes(
                  'assets/pic',
                ),
              )
            await page.evaluate(async () => {
              for (let i = 0; i < 3; i++)
                await new Promise(requestAnimationFrame)
            })
            const after = await snapshot(page)
            // atom-list-001: rich's numbered-list edit either refuses the change
            // or keeps two-space continuation and then refuses typed replacement.
            const numbered = container === 'list' && action === 'numbered-list'
            const nativeConverts = ['divider', 'image', 'comment'].includes(
              kind,
            )
            if (numbered) {
              const expected =
                engine === 'codemirror'
                  ? ordered(block)
                  : nativeConverts
                    ? `plain\n\n1. item\n \n  ${block}\n`
                    : source
              assert.equal(after.source, expected, `${name}: ${action} source`)
              assert.equal(after.selected, true)
            } else compare(`${name}: ${action}`, after)
            if (action === 'image') {
              assert.equal(
                after.selected,
                true,
                'the replacement image stays selected',
              )
              assert.match(after.source, /!\[pic\]\(assets\/pic\.png\)/)
              await page.keyboard.press(`${mod}+z`)
              assert.equal((await snapshot(page)).source, source)
              await page.keyboard.press(`${mod}+Shift+z`)
              assert.deepEqual(await snapshot(page), after)
            }
            await page.keyboard.type('Z')
            const typed = await snapshot(page)
            if (numbered) {
              if (engine === 'tiptap' && nativeConverts)
                assert.deepEqual(typed, after)
              else {
                const expected =
                  engine === 'codemirror' ? ordered('Z') : containers.list('Z')
                assert.deepEqual(
                  { document: parse(typed.source), selected: typed.selected },
                  { document: parse(expected), selected: false },
                )
              }
            } else compare(`${name}: ${action} then type`, typed)
          })
      }
  },
)
