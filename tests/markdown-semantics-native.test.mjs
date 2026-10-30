import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { formattedMarkdownParser } from '../src/shared/formatted-markdown.ts'
import { markdownSourceParser } from '../src/shared/markdown-source-references.ts'
import {
  electron,
  waitForDocumentEditor,
  waitForFormattedEditor,
} from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const cases = [
  { name: 'empty', source: '' },
  { name: 'whitespace', source: '\n\n\n\n' },
  { name: 'crlf whitespace', source: ' \r\n\r\n\t\r\n' },
  { name: 'paragraphs', source: '# first\n\nbody\n\n\n\n## last\n\n' },
  {
    name: 'crlf',
    source: '# heading\r\n\r\n**bold** and *italic*\r\n\r\nlast\r\n',
  },
  {
    name: 'inline',
    source:
      '# **bold** [link](https://example.com)\n\n![photo](photo.png) and `code`',
  },
  {
    name: 'lists',
    source: '- # first\n- second\n\n> ## nested\n> quote\n\n# outer',
  },
  { name: 'lazy quote', source: '> first\n-# small\n> last\n\n# outer' },
  {
    name: 'lazy definition',
    source: '> [ref]: /quote\nplain text\n\n[ref]\n\n# after',
  },
  {
    name: 'gfm',
    source:
      '| a | b |\n|---|---|\n| c | d |\n\n> [!TIP]\n> **careful**\n\n~~strike~~',
  },
  { name: 'extras', source: 'H~2~O\n\n-# small **words**\n\n# after' },
  {
    name: 'references',
    source: '[ref]: /first\n\n# [label][REF]\n\n[ref]: /second\n\n[missing]',
  },
  {
    name: 'forward references',
    source: '-# [ref]\n\n# [ref]\n\n[ref]: /later',
  },
  {
    name: 'reference edits',
    source: '[ref]: /first\n\n# [label][ref]\n\nlast',
    edit: { from: 7, to: 13, insert: '/changed' },
  },
  { name: 'grapheme seams', source: 'carriage&#13;\n\n# after 👩🏽‍💻\n\né 🇵🇭' },
  { name: 'long paragraph', source: `${'text '.repeat(1800)}\n\n# after` },
  {
    name: 'long fence',
    source: `\`\`\`txt\n${'code '.repeat(1800)}\n\`\`\`\n\n# after`,
  },
  {
    name: 'html',
    source: '<div>\n[ref]: /hidden\n</div>\n\n[ref]',
  },
  {
    name: 'inline html',
    source: 'words <em>native</em>\n\n# after',
  },
  {
    name: 'multiline title',
    source: '[ref]: /target "first\n\n# title\nlast"\n\n[ref]',
  },
  {
    name: 'quoted title',
    source: '[ref]: /target "title"\n\n[ref]',
  },
  {
    name: 'long physical heading',
    source: `# ${'a'.repeat(4094)}[other]: /fake\n\n[other]`,
  },
  {
    name: 'task list',
    source: '- [ ] todo\n- [x] done\n\n# after',
  },
  { name: 'intraword non-bmp symbol', source: 'ab**😀cd**ef' },
  { name: 'intraword non-bmp punctuation', source: 'ab**𐩐cd**ef' },
  {
    name: 'non-bmp emphasis controls',
    source: 'ab**cd**ef **😀cd** ab**€cd**ef',
  },
]

for (const fixture of cases.filter((item) =>
  item.name.startsWith('intraword non-bmp'),
))
  test(`formatted syntax keeps ${fixture.name} delimiters literal`, () => {
    const tokens = markdownSourceParser({ gfm: true }).lexer(fixture.source)
    assert.equal(
      tokens[0].tokens.some((token) => token.type === 'strong'),
      false,
    )
    assert.equal(
      formattedMarkdownParser([]).parse(fixture.source).toString(),
      'Document(Paragraph)',
      'CommonMark punctuation includes Unicode P and S code points',
    )
  })

// A reference in a subtext line resolves against later definitions too, an
// accepted difference: the native schema reads subtext before them.
const formattedDifferences = {
  '0/forward references/0': { text: 'ref ref' },
  '1/forward references/0': { text: 'ref # [ref]' },
}

// Frozen outcomes, checked by the native control before its removal.
const formattedOutcomes = {
  '0/intraword non-bmp symbol/0': {
    text: 'ab**😀cd**ef',
    headings: [],
    counts: { words: 3, characters: 11 },
  },
  '0/intraword non-bmp punctuation/0': {
    text: 'ab**𐩐cd**ef',
    headings: [],
    counts: { words: 3, characters: 11 },
  },
  '0/non-bmp emphasis controls/0': {
    text: 'abcdef 😀cd ab**€cd**ef',
    headings: [],
    counts: { words: 5, characters: 22 },
  },
  '0/empty/0': { text: '', headings: [], counts: { words: 0, characters: 0 } },
  '0/whitespace/0': {
    text: '\n',
    headings: [],
    counts: { words: 0, characters: 1 },
  },
  '0/crlf whitespace/0': {
    text: '',
    headings: [],
    counts: { words: 0, characters: 0 },
  },
  '0/paragraphs/0': {
    text: 'first\nbody\n\nlast\n',
    headings: ['first', 'last'],
    counts: { words: 3, characters: 17 },
  },
  '0/crlf/0': {
    text: 'heading\nbold and italic\nlast',
    headings: ['heading'],
    counts: { words: 5, characters: 28 },
  },
  '0/inline/0': {
    text: 'bold link\n\n and code',
    headings: ['bold link'],
    counts: { words: 4, characters: 20 },
  },
  '0/lists/0': {
    text: '\n\nfirst\n\nsecond\n\nnested\nquote\nouter',
    headings: ['first', 'nested', 'outer'],
    counts: { words: 5, characters: 35 },
  },
  '0/lazy quote/0': {
    text: '\nfirst\nsmall\nlast\nouter',
    headings: ['outer'],
    counts: { words: 4, characters: 23 },
  },
  '0/lazy definition/0': {
    text: '\nplain text\nref\nafter',
    headings: ['after'],
    counts: { words: 4, characters: 21 },
  },
  '0/gfm/0': {
    text: '\n\n\na\n\nb\n\n\nc\n\nd\n\ncareful\nstrike',
    headings: [],
    counts: { words: 6, characters: 30 },
  },
  '0/extras/0': {
    text: 'H2O\nsmall words\nafter',
    headings: ['after'],
    counts: { words: 4, characters: 21 },
  },
  '0/references/0': {
    text: 'label\n[missing]',
    headings: ['label'],
    counts: { words: 2, characters: 15 },
  },
  '0/forward references/0': {
    text: '[ref]\nref',
    headings: ['ref'],
    counts: { words: 2, characters: 9 },
  },
  '0/reference edits/0': {
    text: 'label\nlast',
    headings: ['label'],
    counts: { words: 2, characters: 10 },
  },
  '0/reference edits/1': {
    text: 'label\nlast',
    headings: ['label'],
    counts: { words: 2, characters: 10 },
  },
  '0/grapheme seams/0': {
    text: 'carriage\r\nafter 👩🏽‍💻\né 🇵🇭',
    headings: ['after 👩🏽‍💻'],
    counts: { words: 3, characters: 20 },
  },
  '0/long paragraph/0': {
    text: `${'text '.repeat(1800)}\nafter`,
    headings: ['after'],
    counts: { words: 1801, characters: 9006 },
  },
  '0/long fence/0': {
    text: `${'code '.repeat(1800)}\nafter`,
    headings: ['after'],
    counts: { words: 1801, characters: 9006 },
  },
  '0/html/0': {
    text: '<div>\n[ref]: /hidden\n</div>\n[ref]',
    headings: [],
    counts: { words: 5, characters: 33 },
  },
  '0/inline html/0': {
    text: 'words <em>native</em>\nafter',
    headings: ['after'],
    counts: { words: 5, characters: 27 },
  },
  '0/multiline title/0': {
    text: '[ref]: /target "first\ntitle\nlast"\n[ref]',
    headings: ['title'],
    counts: { words: 6, characters: 39 },
  },
  '0/quoted title/0': {
    text: 'ref',
    headings: [],
    counts: { words: 1, characters: 3 },
  },
  '0/long physical heading/0': {
    text: `${'a'.repeat(4094)}[other]: /fake\n[other]`,
    headings: [`${'a'.repeat(4094)}[other]: /fake`],
    counts: { words: 4, characters: 4116 },
  },
  '0/task list/0': {
    text: '\n\ntodo\n\ndone\nafter',
    headings: ['after'],
    counts: { words: 3, characters: 18 },
  },
  '1/intraword non-bmp symbol/0': {
    text: 'ab**😀cd**ef',
    headings: [],
    counts: { words: 3, characters: 11 },
  },
  '1/intraword non-bmp punctuation/0': {
    text: 'ab**𐩐cd**ef',
    headings: [],
    counts: { words: 3, characters: 11 },
  },
  '1/non-bmp emphasis controls/0': {
    text: 'ab**cd**ef **😀cd** ab**€cd**ef',
    headings: [],
    counts: { words: 7, characters: 30 },
  },
  '1/empty/0': { text: '', headings: [], counts: { words: 0, characters: 0 } },
  '1/whitespace/0': {
    text: '\n',
    headings: [],
    counts: { words: 0, characters: 1 },
  },
  '1/crlf whitespace/0': {
    text: '',
    headings: [],
    counts: { words: 0, characters: 0 },
  },
  '1/paragraphs/0': {
    text: '# first\nbody\n\nlast\n',
    headings: ['last'],
    counts: { words: 3, characters: 19 },
  },
  '1/crlf/0': {
    text: '# heading\n**bold** and italic\nlast',
    headings: [],
    counts: { words: 5, characters: 34 },
  },
  '1/inline/0': {
    text: '# **bold** [link](https://example.com)\n![photo](photo.png) and code',
    headings: [],
    counts: { words: 10, characters: 67 },
  },
  '1/lists/0': {
    text: '\n\n# first\n\nsecond\n\nnested\nquote\n# outer',
    headings: ['nested'],
    counts: { words: 5, characters: 39 },
  },
  '1/lazy quote/0': {
    text: '\nfirst\nsmall\nlast\n# outer',
    headings: [],
    counts: { words: 4, characters: 25 },
  },
  '1/lazy definition/0': {
    text: '\nplain text\nref\n# after',
    headings: [],
    counts: { words: 4, characters: 23 },
  },
  '1/gfm/0': {
    text: '\n\n\na\n\nb\n\n\nc\n\nd\n\ncareful\nstrike',
    headings: [],
    counts: { words: 6, characters: 30 },
  },
  '1/extras/0': {
    text: 'H2O\nsmall words\n# after',
    headings: [],
    counts: { words: 4, characters: 23 },
  },
  '1/references/0': {
    text: '# [label][REF]\n[missing]',
    headings: [],
    counts: { words: 3, characters: 24 },
  },
  '1/forward references/0': {
    text: '[ref]\n# [ref]',
    headings: [],
    counts: { words: 2, characters: 13 },
  },
  '1/reference edits/0': {
    text: '# [label][ref]\nlast',
    headings: [],
    counts: { words: 3, characters: 19 },
  },
  '1/reference edits/1': {
    text: '# [label][ref]\nlast',
    headings: [],
    counts: { words: 3, characters: 19 },
  },
  '1/grapheme seams/0': {
    text: 'carriage\r\n# after 👩🏽‍💻\né 🇵🇭',
    headings: [],
    counts: { words: 3, characters: 22 },
  },
  '1/long paragraph/0': {
    text: `${'text '.repeat(1800)}\n# after`,
    headings: [],
    counts: { words: 1801, characters: 9008 },
  },
  '1/long fence/0': {
    text: `${'code '.repeat(1800)}\n# after`,
    headings: [],
    counts: { words: 1801, characters: 9008 },
  },
  '1/html/0': {
    text: '<div>\n[ref]: /hidden\n</div>\n[ref]',
    headings: [],
    counts: { words: 5, characters: 33 },
  },
  '1/inline html/0': {
    text: 'words <em>native</em>\n# after',
    headings: [],
    counts: { words: 5, characters: 29 },
  },
  '1/multiline title/0': {
    text: '[ref]: /target "first\n# title\nlast"\n[ref]',
    headings: [],
    counts: { words: 6, characters: 41 },
  },
  '1/quoted title/0': {
    text: 'ref',
    headings: [],
    counts: { words: 1, characters: 3 },
  },
  '1/long physical heading/0': {
    text: `# ${'a'.repeat(4094)}[other]: /fake\n[other]`,
    headings: [],
    counts: { words: 4, characters: 4118 },
  },
  '1/task list/0': {
    text: '\n\ntodo\n\ndone\n# after',
    headings: [],
    counts: { words: 3, characters: 20 },
  },
}

// The notes keep their canonical source, visible outline and rendered-text
// counts, the outcomes the removed native editor's control matched.
test('semantic fixtures preserve source, headings and formatted counts', {
  timeout: 240000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-semantic-formatted-'))
  const profile = join(root, 'profile')
  await mkdir(profile)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'word-count': true }),
  )
  assert.equal(Object.keys(formattedOutcomes).length, 54)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const configurations = [[], ['core.heading-1', 'core.bold', 'core.images']]
  await page.addInitScript(() => {
    window.semanticCountSequence = 0
    window.semanticCountReplies = []
    window.Worker = new Proxy(window.Worker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args)
        if (String(args[0]).includes('/counter.worker-')) {
          const pending = []
          const streams = new Map()
          const post = worker.postMessage.bind(worker)
          worker.postMessage = (message, ...rest) => {
            if (message.kind === 'open')
              streams.set(message.head.streamId, message.head)
            if (typeof message === 'string')
              pending.push({
                sequence: ++window.semanticCountSequence,
                source: message,
              })
            else if (message.kind === 'count') {
              const head = streams.get(message.streamId)
              pending.push({
                sequence: ++window.semanticCountSequence,
                document: {
                  tabId: head.tabId,
                  revision: head.revision,
                  contentVersion: message.version,
                },
              })
            }
            return post(message, ...rest)
          }
          worker.addEventListener('message', ({ data }) => {
            if (data.kind && data.kind !== 'count') return
            window.semanticCountReplies.push({
              ...pending.shift(),
              counts: data.kind === 'count' ? data.result : data,
            })
          })
        }
        return worker
      },
    })
  })
  await waitForFormattedEditor(app, page)
  const statusLabel = ({ words, characters }) =>
    `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} · ${characters.toLocaleString()} ${characters === 1 ? 'character' : 'characters'}`
  for (const [configuration, disabled] of configurations.entries()) {
    await page.evaluate(
      (disabled) =>
        localStorage.setItem(
          'hibi:markdown-syntax-disabled',
          JSON.stringify(disabled),
        ),
      disabled,
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
    await page.getByRole('button', { name: /^toggle right sidebar$/i }).click()
    await page.getByRole('button', { name: /^right sidebar views$/i }).click()
    await page
      .getByRole('menuitem', { name: 'On this page', exact: true })
      .click()
    for (const [index, fixture] of cases.entries()) {
      let afterCount = await page.evaluate(() => window.semanticCountSequence)
      const file = join(root, `${configuration}-${index}.md`)
      await writeFile(file, fixture.source)
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
        `${configuration}-${index}.md`,
      )
      const rich = page.getByRole('textbox', {
        name: 'Document editor',
        exact: true,
      })
      const sources = [fixture.source]
      if (fixture.edit)
        sources.push(
          fixture.source.slice(0, fixture.edit.from) +
            fixture.edit.insert +
            fixture.source.slice(fixture.edit.to),
        )
      for (const [pass, source] of sources.entries()) {
        const key = `${configuration}/${fixture.name}/${pass}`
        const expected = formattedOutcomes[key] && {
          ...formattedOutcomes[key],
          ...formattedDifferences[key],
        }
        assert.ok(
          expected,
          `Missing semantic outcome for ${fixture.name}, pass ${pass}`,
        )
        if (pass) {
          afterCount = await page.evaluate(() => window.semanticCountSequence)
          await rich.evaluate((element, edit) => {
            const view = element.cmTile.root.view
            view.dispatch({
              selection: { anchor: edit.from, head: edit.to },
              scrollIntoView: true,
            })
            view.focus()
          }, fixture.edit)
          await page.keyboard.insertText(fixture.edit.insert)
        }
        await waitForAsync(
          page,
          async (source) =>
            (await window.hibi.getDocument()).markdown === source,
          source,
        )
        const expectedHeadings = expected.headings
        const formattedText = expected.text
        const formattedCount = statusLabel(expected.counts)
        // Await a reply sent after this note/edit, so a previous note with
        // identical counts cannot satisfy readiness.
        const current = await page.evaluate(() => window.hibi.getDocument())
        const request = {
          afterCount,
          source,
          text: formattedText,
          document: {
            tabId: current.tabId,
            revision: current.revision,
            contentVersion: current.contentVersion,
          },
        }
        await page.waitForFunction(
          ({ afterCount, source, text, document }) =>
            window.semanticCountReplies.some(
              (reply) =>
                reply.sequence > afterCount &&
                reply.counts &&
                (reply.source === source ||
                  reply.source === text ||
                  (reply.document?.tabId === document.tabId &&
                    reply.document.revision === document.revision &&
                    reply.document.contentVersion === document.contentVersion)),
            ),
          request,
        )
        const reply = await page.evaluate(
          ({ afterCount, source, text, document }) =>
            window.semanticCountReplies.findLast(
              (reply) =>
                reply.sequence > afterCount &&
                reply.counts &&
                (reply.source === source ||
                  reply.source === text ||
                  (reply.document?.tabId === document.tabId &&
                    reply.document.revision === document.revision &&
                    reply.document.contentVersion === document.contentVersion)),
            ),
          request,
        )
        await page.waitForFunction(
          (label) =>
            document.querySelector('[data-status-id="word-count.total"]')
              ?.textContent === label,
          statusLabel(reply.counts),
        )
        await waitForAsync(
          page,
          () =>
            new Promise((resolve) =>
              requestIdleCallback(() => resolve(true), { timeout: 16 }),
            ),
        )
        await t.test(
          `${fixture.name}, pass ${pass}, ${disabled.length ? 'disabled' : 'default'} syntax`,
          async (t) => {
            // Outline labels settle independently from word-count replies.
            await page.waitForFunction(
              (labels) =>
                JSON.stringify(
                  [
                    ...document.querySelectorAll(
                      '.outline-sidebar[data-side="right"] .sidebar-label',
                    ),
                  ].map((node) => node.textContent),
                ) === JSON.stringify(labels),
              expectedHeadings,
            )
            const actual = await page.evaluate(() => ({
              counts: document.querySelector(
                '[data-status-id="word-count.total"]',
              )?.textContent,
              headings: [
                ...document.querySelectorAll(
                  '.outline-sidebar[data-side="right"] .sidebar-label',
                ),
              ].map((node) => node.textContent),
            }))
            t.diagnostic(
              JSON.stringify({
                fixture: fixture.name,
                pass,
                disabled,
                expected: {
                  counts: formattedCount,
                  headings: expectedHeadings,
                },
                actual,
              }),
            )
            assert.equal(
              (await page.evaluate(() => window.hibi.getDocument())).markdown,
              source,
            )
            assert.equal(
              await rich.evaluate((element) =>
                element.cmTile.root.view.state.doc.toString(),
              ),
              source.replace(/\r\n?/g, '\n'),
            )
            if (
              fixture.name === 'long paragraph' ||
              fixture.name === 'long fence'
            ) {
              await rich.press('ControlOrMeta+End')
              await rich.evaluate((element) => element.blur())
              if (!disabled.includes('core.heading-1'))
                await rich
                  .getByRole('heading', { name: 'after', exact: true })
                  .waitFor()
            }
            assert.equal(
              actual.counts,
              formattedCount,
              'formatted counts exclude Markdown syntax, as the frozen native outcome does',
            )
            await rich.evaluate((element) => element.blur())
            /** The view's visible text, or whether it is `expected`. */
            const visible = (expected) => {
              const element = document.querySelector('.rich-pane .cm-content')
              let text = element.innerText
              for (const label of element.querySelectorAll(
                '.cm-placeholder, .hibi-lp-alert-title',
              ))
                text = text.replace(label.innerText, '')
              text = text.replace(/\s+/g, ' ').trim()
              return expected === undefined ? text : text === expected
            }
            // Blur, focus handling and reference answers settle over several
            // frames: wait for the expected text before reading it.
            const expectedText = formattedText.replace(/\s+/g, ' ').trim()
            await page.waitForFunction(visible, expectedText).catch((error) => {
              if (error.name !== 'TimeoutError') throw error
            })
            assert.equal(
              await page.evaluate(visible),
              expectedText,
              'visible formatted text matches the native text oracle',
            )
            if (fixture.name.includes('non-bmp'))
              assert.deepEqual(
                await rich.locator('.hibi-lp-strong').allInnerTexts(),
                !disabled.length && fixture.name === 'non-bmp emphasis controls'
                  ? ['cd', '😀cd']
                  : [],
                `Visible strong marks: ${fixture.name}`,
              )
            assert.deepEqual(actual.headings, expectedHeadings)
          },
        )
      }
    }
    // Sidebar visibility is persisted across reloads.
    await page.getByRole('button', { name: /^toggle right sidebar$/i }).click()
  }
})
