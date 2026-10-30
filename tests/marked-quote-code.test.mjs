import assert from 'node:assert/strict'
import test from 'node:test'
import { history, isolateHistory, redo, undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { Decoration } from '@codemirror/view'
import { parser } from '@lezer/markdown'
import { Strike } from '@tiptap/extension-strike'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import { MarkdownManager } from '@tiptap/markdown'
import { Lexer, Marked, Tokenizer } from 'marked'
import { markedGithubFootnote } from 'marked-github-footnote'
import { micromark } from 'micromark'
import { gfmHtml, gfm as gfmSyntax } from 'micromark-extension-gfm'
import { alertMarkdown } from '../src/addons/markdown/alerts.ts'
import { GithubAlert } from '../src/addons/markdown/GithubAlert.ts'
import { NativeTableKit } from '../src/addons/markdown/table-tokenizer.ts'
import { codeIndent, indent } from '../src/renderer/src/formatted-commands.ts'
import { markdownConfiguration } from '../src/renderer/src/markdown.ts'
import { BlockTokenizer, blockMarkdown } from '../src/shared/marked-blocks.ts'

const github = {
  id: 'markdown.github',
  markedOptions: { gfm: true },
  richExtensions: [
    GithubAlert,
    Strike,
    NativeTableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
  ],
  export: { extensions: [alertMarkdown, markedGithubFootnote()] },
}

const code = (html) =>
  html.match(/<pre><code[^>]*>[\s\S]*?<\/code><\/pre>/g) ?? []
const contexts = [
  ['quote', '> ', '> '],
  ['compact quote', '>', '>'],
  ['indented quote', '  > ', '  > '],
  ['nested quotes', '> > ', '> > '],
  ['compact nested quotes', '>> ', '>> '],
  ['quote in item', '- > ', '  > '],
  ['quote in nested item', '- - > ', '    > '],
]

test('quote preprocessing preserves fenced body tabs and reference neighbors', async (t) => {
  for (const [name, first, rest] of contexts)
    for (const fence of ['```', '````', '~~~', '~~~~~'])
      for (const eol of ['\n', '\r\n'])
        await t.test(`${name}, ${fence}, ${JSON.stringify(eol)}`, () => {
          const lines = [
            `${first}${fence}js`,
            `${rest}\tcode\tinside`,
            `${rest}  \tlater`,
            `${rest}>\tliteral quote`,
            `${rest}${fence[0].repeat(fence.length - 1)}`,
            `${rest}${fence[0] === '`' ? '~~~~~~' : '``````'}`,
            `${rest}\tafter false closers`,
            `${rest}${fence}${fence[0]}`,
            rest.trimEnd(),
            `${rest}[ref]: /x`,
            `${rest}\t"a | b"`,
            `${rest}--|--`,
            '',
            '[ref]',
          ]
          const source = lines.join(eol)
          const normalized = source.replaceAll('\r\n', '\n')
          const oracle = micromark(source, {
            extensions: [gfmSyntax()],
            htmlExtensions: [gfmHtml()],
          }).replaceAll('\r\n', '\n')
          const markdown = new Marked({ gfm: true }, blockMarkdown)
          assert.deepEqual(code(markdown.parse(source)), code(oracle), source)
          for (const tokens of [
            markdown.lexer(source),
            new Lexer({ gfm: true, tokenizer: new BlockTokenizer() }).lex(
              source,
            ),
          ])
            assert.equal(tokens.map(({ raw }) => raw).join(''), normalized)
          assert.equal(
            markdown.lexer(source).links.ref?.title ?? null,
            /title="a \| b"/.test(oracle) ? 'a | b' : null,
          )
        })
})

test('escaped and invalid backtick fence starts leave quote title handling active', () => {
  for (const opening of ['\\```', '```bad`info']) {
    const source = `> ${opening}\n> \t"a | b"\n> --|--\n>\n> [ref]: /x\n> \t"c | d"\n> --|--\n\n[ref]`
    const oracle = micromark(source, {
      extensions: [gfmSyntax()],
      htmlExtensions: [gfmHtml()],
    }).replaceAll('\r\n', '\n')
    const markdown = new Marked({ gfm: true }, blockMarkdown)
    assert.equal(
      markdown.lexer(source).links.ref?.title ?? null,
      /title="c \| d"/.test(oracle) ? 'c | d' : null,
    )
    assert.deepEqual(code(markdown.parse(source)), code(oracle))
  }
})

const structural = [
  '> ```\n>\tcode\n> ```',
  '>  ```\n> \tcode\n>  ```',
  '>   ```\n> \tcode\n>   ```',
  '>    ```\n>   \tcode\n>    ```',
  '> > ```\n>> \tcode\n> > ```',
  '> > ```\n>\t> \tcode\n> > ```',
  '> ```\n> \tfirst\n>     \tcode\n> ```',
  '> ~~~\n> \tcode\n> >\tliteral\n',
]

test('fenced code keeps residual structural tab columns and unclosed bodies', () => {
  for (const source of structural)
    for (const eol of ['\n', '\r\n']) {
      const text = source.replaceAll('\n', eol)
      const oracle = micromark(text).replaceAll('\r\n', '\n')
      const markdown = new Marked({ gfm: false }, blockMarkdown)
      assert.deepEqual(code(markdown.parse(text)), code(oracle), text)
      assert.equal(
        markdown
          .lexer(text)
          .map(({ raw }) => raw)
          .join(''),
        source,
      )
    }
})

test('quoted list compensation keeps preexisting native rules distinct and tilde fences follow CommonMark', () => {
  for (const source of [
    '>  ~~~\n>  \tcode\n>  ~~~',
    '>   ~~~\n>   \tcode\n>   ~~~',
  ]) {
    const native = new Marked({ gfm: false }).parse(source)
    assert.notDeepEqual(code(native), code(micromark(source)), source)
    assert.deepEqual(
      code(new Marked({ gfm: false }, blockMarkdown).parse(source)),
      code(micromark(source)),
      source,
    )
  }
  for (const source of [
    '> - item\n>\n>   ```\n>   foo\n>   \tbar\n>   ```',
    '> - a\n>   - b\n>\n>     ```\n>     foo\n>     \tbar\n>     ```',
  ]) {
    const native = new Marked({ gfm: false }).parse(source)
    const oracle = micromark(source)
    assert.notDeepEqual(
      code(native),
      code(oracle),
      'preexisting native difference must stay explicit',
    )
    assert.deepEqual(
      code(new Marked({ gfm: false }, blockMarkdown).parse(source)),
      code(native),
      source,
    )
  }
})

test('quote code protection retains one native parse across growing blocks', () => {
  const measure = (source, tokenizer) => {
    const lexer = new Lexer({ gfm: true, tokenizer })
    const read = lexer.blockTokens
    let calls = 0,
      units = 0
    lexer.blockTokens = function (source, ...args) {
      calls++
      units += source.length
      return read.call(this, source, ...args)
    }
    const tokens = lexer.lex(source)
    return { calls, units, tokens }
  }
  for (const size of [128, 512, 2048]) {
    const source = '> ```\n' + '> \tline\n'.repeat(size) + '> ```\n\nsuffix'
    const plain = measure(source, new Tokenizer())
    const fixed = measure(source, new BlockTokenizer())
    assert.equal(
      fixed.calls,
      plain.calls,
      'code protection must not reparse a quote',
    )
    assert.ok(fixed.units <= plain.units * 2)
    assert.equal(fixed.tokens.map(({ raw }) => raw).join(''), source)
    const code = fixed.tokens[0].tokens.find(({ type }) => type === 'code')
    assert.equal(code.text, '\tline\n'.repeat(size).slice(0, -1))
  }
})

test('structural quote tabs retain physical columns, source bytes and history', () => {
  const cases = [
    ...[0, 1, 2, 3].map((spaces) => {
      const prefix = ' '.repeat(spaces)
      const unit = [2, 1, 0, 3][spaces]
      return [
        `${prefix}> \`\`\`\n${prefix}>foo|\n${prefix}>\tbar\n${prefix}> \`\`\``,
        unit >= 2 ? ' '.repeat(unit) : '\t',
      ]
    }),
    ['> > > > ```\n> > > > foo|\n>>>>\tbar\n> > > > ```', '   '],
    ['-\t> ```\n    >foo|\n    >\tbar\n    > ```', '  '],
    ['- > ```\n  >foo|\n  >\tbar\n  > ```', '\t'],
  ]
  for (const [sample, unit] of cases)
    for (const eol of ['\n', '\r\n']) {
      const doc = ('untouched 🌱\n\n' + sample + '\n\nsuffix').replaceAll(
        '\n',
        eol,
      )
      const source = doc.replace('|', '')
      const rawCaret = doc.indexOf('|')
      const caret = doc.replaceAll('\r\n', '\n').indexOf('|')
      const state = EditorState.create({
        doc: source,
        selection: { anchor: caret },
        extensions: [history(), codeIndent, EditorState.lineSeparator.of(eol)],
      })
      const spec = indent(
        state,
        parser.parse(state.doc.toString()),
        false,
        Decoration.none,
      )
      assert.ok(spec)
      let next = state.update(spec, {
        annotations: isolateHistory.of('full'),
      }).state
      const expected = source.slice(0, rawCaret) + unit + source.slice(rawCaret)
      assert.equal(next.sliceDoc(), expected, sample)
      assert.equal(next.selection.main.head, caret + unit.length)
      const changes = []
      state
        .changes(spec.changes)
        .iterChanges((from, to, _from, _to, text) =>
          changes.push([from, to, text.toString()]),
        )
      assert.deepEqual(changes, [[caret, caret, unit]])
      const dispatch = (transaction) => {
        next = transaction.state
      }
      assert.ok(undo({ state: next, dispatch }))
      assert.equal(next.sliceDoc(), source)
      assert.equal(next.selection.main.head, caret)
      assert.ok(redo({ state: next, dispatch }))
      assert.equal(next.sliceDoc(), expected)
      assert.equal(next.selection.main.head, caret + unit.length)
    }
})

test('lazy nested quote continuation retains literal fenced tabs and raw offsets', () => {
  for (const fence of ['```', '~~~'])
    for (const eol of ['\n', '\r\n']) {
      const source =
        `> > paragraph\nlazy\n> >\n> > ${fence}\n> > \tcode\n> > ${fence}`.replaceAll(
          '\n',
          eol,
        )
      const oracle = micromark(source).replaceAll('\r\n', '\n')
      const markdown = new Marked({ gfm: false }, blockMarkdown)
      assert.deepEqual(code(markdown.parse(source)), code(oracle), source)
      assert.equal(
        markdown
          .lexer(source)
          .map(({ raw }) => raw)
          .join(''),
        source.replaceAll('\r\n', '\n'),
      )
    }
})

test('identical normalized sibling bodies retain tab provenance in both orders', () => {
  for (const [, first, rest] of contexts)
    for (const fence of ['```', '~~~'])
      for (const eol of ['\n', '\r\n'])
        for (const tabsFirst of [true, false]) {
          const body = rest.endsWith(' ') ? rest : rest + ' '
          const spaces = ' '.repeat(4 - (body.length % 4))
          const indents = tabsFirst
            ? ['\t', spaces, '\t']
            : [spaces, '\t', spaces]
          const lines = []
          for (const [index, indent] of indents.entries())
            lines.push(
              (index ? rest : first) + fence,
              body + indent + 'same',
              rest + fence,
              rest.trimEnd(),
            )
          lines.push(rest + '[ref]: /x', rest + '[ref]')
          const source = lines.join(eol)
          const native = new Marked({ gfm: false })
          const markdown = new Marked({ gfm: false }, blockMarkdown)
          assert.deepEqual(markdown.lexer(source), native.lexer(source), source)
          assert.equal(markdown.parse(source), native.parse(source), source)
          assert.deepEqual(
            code(markdown.parse(source)),
            code(micromark(source).replaceAll('\r\n', '\n')),
            source,
          )
        }
})

test('lazy frame transitions preserve quote text, nested siblings and parser reuse', () => {
  const markdown = new Marked({ gfm: false }, blockMarkdown)
  const native = new Marked({ gfm: false })
  for (const fence of ['```', '~~~'])
    for (const eol of ['\n', '\r\n'])
      for (const [start, prefix] of [
        ['> > x\n> > y\nlazy\n> >', '> > '],
        ['> > first\n>\n> > x\n> > y\nlazy\n> >', '> > '],
        ['> - > x\n>   > y\nlazy\n>   >', '>   > '],
        ['> > - x\nlazy\n> >\n> >   > y\n> >   >', '> >   > '],
        ['> - x\nlazy\n>\n>   > y\n>   >', '>   > '],
        ['> - x\nlazy\n>\n> # next\n>', '> '],
        ['> > - x\nlazy\n> >\n> > # next\n> >', '> > '],
        ['> - x\nlazy one\nlazy two\n>\n> > y\n> >', '> > '],
        ['> > x\n> > ===\nlazy\n> >', '> > '],
      ]) {
        const source = (
          start +
          '\n' +
          prefix +
          fence +
          '\n' +
          prefix +
          '\tcode\n' +
          prefix +
          fence +
          '\n\n[ref]: /x "title"\n\n[ref]'
        ).replaceAll('\n', eol)
        const [{ raw, ...quote }, ...tail] = markdown.lexer(source)
        const [{ raw: nativeRaw, ...nativeQuote }, ...nativeTail] =
          native.lexer(source)
        const normalized = source.replaceAll('\r\n', '\n')
        assert.equal(raw, normalized.slice(0, raw.length), source)
        assert.equal(
          raw + tail.map(({ raw }) => raw).join(''),
          normalized,
          source,
        )
        // Native lazy list continuation can duplicate its outer raw prefix.
        if (nativeRaw !== raw) assert.ok(start.includes('-'))
        assert.deepEqual(quote, nativeQuote, source)
        assert.deepEqual(tail, nativeTail, source)
        assert.equal(markdown.parse(source), native.parse(source), source)
        assert.equal(
          markdown.parse('[ref]: /next\n\n[ref]'),
          native.parse('[ref]: /next\n\n[ref]'),
        )
      }
})

test('quote protection preserves extension work, inline queues and parser state', () => {
  const exercise = (fixed) => {
    let calls = 0
    const markdown = new Marked(
      { gfm: false },
      {
        extensions: [
          {
            name: 'quote-probe',
            level: 'block',
            tokenizer(source) {
              calls++
              if (!source.startsWith('probe\n')) return
              const text = '**inline [ref]**'
              return {
                type: 'paragraph',
                raw: 'probe\n',
                text,
                tokens: this.lexer.inline(text),
              }
            },
          },
        ],
      },
      ...(fixed ? [blockMarkdown] : []),
    )
    const lexer = new Lexer(markdown.defaults)
    const rules = lexer.tokenizer.rules
    const blockTokens = lexer.blockTokens
    const tokens = lexer.lex(
      '> probe\n>\n> ```\n> \tcode\n> ```\n>\n> [ref]: /x\n>\n> [ref]\n',
    )
    assert.equal(lexer.tokenizer.rules, rules)
    assert.equal(lexer.blockTokens, blockTokens)
    assert.equal(lexer.inlineQueue.length, 0)
    assert.equal(lexer.state.top, true)
    return { calls, tokens, html: markdown.parser(tokens) }
  }
  assert.deepEqual(exercise(true), exercise(false))
})

test('throwing quote and list reads restore grammar, hooks and container metadata', () => {
  const sentinel = new Error('probe')
  for (const list of [false, true])
    for (const fence of [false, true]) {
      let failing = fence
      class ThrowingTokenizer extends BlockTokenizer {
        fences(source) {
          return super.fences(source, function (source) {
            const token = Tokenizer.prototype.fences.call(this, source)
            if (token && failing) throw sentinel
            return token
          })
        }
      }
      const tokenizer = new ThrowingTokenizer()
      const lexer = new Lexer({
        gfm: true,
        tokenizer,
        extensions: {
          block: [
            (source) => {
              if (source.startsWith('explode')) throw sentinel
            },
          ],
        },
      })
      const rules = tokenizer.rules
      const blockTokens = lexer.blockTokens
      const sourceFail = fence
        ? list
          ? '> - > ```\n>   > \tcode\n>   > ```'
          : '> > ```\n> > \tcode\n> > ```'
        : list
          ? '> - > explode\n>   > \tcode'
          : '> > explode\n> > \tcode'
      assert.throws(
        () => lexer.lex(sourceFail),
        (error) => error === sentinel,
      )
      failing = false
      assert.equal(tokenizer.rules, rules)
      assert.equal(lexer.blockTokens, blockTokens)
      assert.equal(tokenizer.fences('```\n\tcode\n```').text, '\tcode')
      const source = '- > [ref]: /x\n  >\t"a | b"\n  > --|--\n\n[ref]'
      const reused = lexer.lex(source)
      const fresh = new Lexer({
        gfm: true,
        tokenizer: new BlockTokenizer(),
      }).lex(source)
      assert.deepEqual(reused, fresh)
      assert.equal(tokenizer.rules, rules)
      assert.equal(lexer.blockTokens, blockTokens)
    }
})

test('sparse prefix and frame work grows with consumed rows', (t) => {
  const measure = (size, dense, alert) => {
    const source =
      (alert ? '> > [!NOTE]\n> >\n' : '> > x\nlazy\n> >\n') +
      Array.from(
        { length: size },
        (_, index) =>
          '> > ```\n> > ' +
          (dense || index % 16 === 0 ? '\t' : '  ') +
          'body\n> > ```\n> >\n',
      ).join('')
    const newline = String.prototype.indexOf
    const exec = RegExp.prototype.exec
    let scanned = 0,
      prefixes = 0
    try {
      String.prototype.indexOf = function (search, from = 0) {
        const at = newline.call(this, search, from)
        if (search === '\n')
          scanned += Math.max(0, (at < 0 ? this.length : at + 1) - from)
        return at
      }
      RegExp.prototype.exec = function (source) {
        const result = exec.call(this, source)
        if (this.sticky && this.source === '[ \\t>]*')
          prefixes += (result?.[0].length ?? 0) + 1
        return result
      }
      new Marked(
        { gfm: false },
        ...(alert ? [alertMarkdown] : []),
        blockMarkdown,
      ).lexer(source)
    } finally {
      String.prototype.indexOf = newline
      RegExp.prototype.exec = exec
    }
    return { units: scanned + prefixes, length: source.length }
  }
  for (const alert of [false, true])
    for (const dense of [false, true]) {
      let prior
      for (const size of [64, 128, 256]) {
        const result = measure(size, dense, alert)
        t.diagnostic(JSON.stringify({ alert, dense, size, ...result }))
        assert.ok(
          result.units < result.length * 12,
          JSON.stringify({ alert, dense, size, ...result }),
        )
        if (prior)
          assert.ok(
            result.units <= prior.units * 2.3,
            JSON.stringify({ alert, dense, size, prior, result }),
          )
        prior = result
      }
    }
})

test('recursive extension bodies retain quote frames, literal tabs and native effects', () => {
  const samples = [
    '> > [!NOTE]\n> > BT\n> > \tcode\n> > BT',
    '> > [!NOTE] title\n> > before **[ref]**\n> >\n> > BT\n> > \tcode\n> > BT\n> >\n> > [ref]: /inside\n> >\n> > [ref]',
    '> > [!NOTE]\n> > text\n>\n> BT\n> \tcode\n> BT',
    '> > [!NOTE]\n> > text\nlazy\n>\n> BT\n> \tcode\n> BT',
    '> > [!NOTE]\n> > BT\n> > \tcode\n> > BT\n>\n> > [!TIP]\n> > BT\n> >     code\n> > BT',
    '> > [!NOTE]\n> > BT\n> >     code\n> > BT\n>\n> > [!TIP]\n> > BT\n> > \tcode\n> > BT',
    '> > > [!NOTE]\n> > > BT\n> > > \tcode\n> > > BT',
    '> - > [!NOTE]\n>   > BT\n>   > \tcode\n>   > BT',
    '- > > [!NOTE]\n  > > BT\n  > > \tcode\n  > > BT',
    '> > [!NOTE]\n> > > [!TIP]\n> > > BT\n> > > \tcode\n> > > BT',
  ]
  const measure = (source, fixed) => {
    const markdown = new Marked(
      { gfm: true },
      alertMarkdown,
      ...(fixed ? [blockMarkdown] : []),
    )
    const lexer = new Lexer(markdown.defaults)
    const rules = lexer.tokenizer.rules,
      options = lexer.options,
      read = Lexer.prototype.blockTokens
    let calls = 0
    Lexer.prototype.blockTokens = function (...args) {
      calls++
      return Reflect.apply(read, this, args)
    }
    const blockTokens = lexer.blockTokens
    try {
      const tokens = lexer.lex(source)
      assert.equal(lexer.tokenizer.rules, rules)
      assert.equal(lexer.blockTokens, blockTokens)
      assert.equal(lexer.options, options)
      assert.equal(lexer.inlineQueue.length, 0)
      assert.equal(lexer.state.top, true)
      return { calls, tokens, html: markdown.parser(tokens) }
    } finally {
      Lexer.prototype.blockTokens = read
    }
  }
  const {
    parser: marked,
    options,
    core,
    addons,
  } = markdownConfiguration([github])
  const manager = new MarkdownManager({
    extensions: [...core, ...addons],
    marked,
    markedOptions: options,
  })
  const codeText = (node) =>
    node.type === 'codeBlock'
      ? [(node.content ?? []).map(({ text }) => text ?? '').join('')]
      : (node.content ?? []).flatMap(codeText)
  for (const template of samples)
    for (const fence of ['```', '~~~'])
      for (const eol of ['\n', '\r\n']) {
        const source = template.replaceAll('BT', fence).replaceAll('\n', eol)
        const fixed = measure(source, true),
          native = measure(source, false)
        assert.deepEqual(fixed, native, source)
        assert.equal(
          fixed.tokens.map(({ raw }) => raw).join(''),
          source.replaceAll('\r\n', '\n'),
        )
        assert.deepEqual(
          codeText(manager.parse(source)),
          codeText(manager.parse(source.replaceAll('\tcode', 'TABcode'))).map(
            (text) => text.replaceAll('TABcode', '\tcode'),
          ),
          source,
        )
      }
})

test('recursive extension failure restores options and allows the same parser to recover', () => {
  const sentinel = new Error('probe')
  const markdown = new Marked({ gfm: true }, alertMarkdown, blockMarkdown, {
    extensions: [
      {
        name: 'throw-body',
        level: 'block',
        tokenizer(source) {
          if (source.startsWith('explode')) throw sentinel
        },
      },
    ],
  })
  const lexer = new Lexer(markdown.defaults)
  const rules = lexer.tokenizer.rules,
    options = lexer.options,
    blockTokens = lexer.blockTokens
  const bad = '> > [!NOTE]\n> > explode\n> > ```\n> > \tcode\n> > ```'
  assert.throws(
    () => lexer.lex(bad),
    (error) => error === sentinel,
  )
  assert.equal(lexer.tokenizer.rules, rules)
  assert.equal(lexer.options, options)
  assert.equal(lexer.blockTokens, blockTokens)
  assert.equal(lexer.tokenizer.fences('```\n\tcode\n```').text, '\tcode')
  assert.throws(
    () => markdown.parse(bad),
    (error) => error === sentinel,
  )
  const source =
    '> > [!TIP]\n> > ```\n> > \tcode\n> > ```\n>\n> [ref]: /next\n>\n> [ref]'
  const native = new Marked({ gfm: true }, alertMarkdown)
  assert.equal(markdown.parse(source), native.parse(source))
  assert.deepEqual(lexer.lex(source), native.lexer(source))
})

test('default native list compositions keep preexisting models and code bytes', async (t) => {
  const cfg = markdownConfiguration([github])
  const extensions = [...cfg.core, ...cfg.addons]
  const nativeCfg = markdownConfiguration([github])
  nativeCfg.parser.defaults.tokenizer = new Tokenizer()
  const nativeMarked = nativeCfg.parser
  const fixed = new MarkdownManager({
    extensions,
    marked: cfg.parser,
    markedOptions: cfg.options,
  })
  const native = new MarkdownManager({
    extensions,
    marked: nativeMarked,
    markedOptions: cfg.options,
  })
  const codeText = (node) =>
    node.type === 'codeBlock'
      ? [(node.content ?? []).map(({ text }) => text ?? '').join('')]
      : (node.content ?? []).flatMap(codeText)
  const cases = [
    ['ordered fence', '> 1. BT\n>    \tcode\n>    BT', [' \tcode', '']],
    [
      'ordered quote',
      '> 1. > BT\n>    > \tcode\n>    > BT',
      ['', 'code\n', ''],
    ],
    [
      'ordered alert',
      '> 1. > [!NOTE]\n>    > BT\n>    > \tcode\n>    > BT',
      ['\tcode'],
    ],
    ['task quote', '> - [ ] > BT\n>   > \tcode\n>   > BT', ['code\n', '']],
    [
      'alert ordered',
      '> > [!NOTE]\n> > 1. BT\n> >    \tcode\n> >    BT',
      [' \tcode', ''],
    ],
  ]
  for (const [name, template, expected] of cases)
    for (const eol of ['\n', '\r\n'])
      await t.test(name + JSON.stringify(eol), () => {
        const source = template
          .replaceAll('BT', String.fromCharCode(96).repeat(3))
          .replaceAll('\n', eol)
        const actual = fixed.parse(source),
          baseline = native.parse(source)
        assert.deepEqual(
          codeText(baseline),
          expected,
          'preexisting native composition remains explicit',
        )
        assert.deepEqual(codeText(actual), expected, source)
        assert.deepEqual(actual, baseline, source)
        const tokens = cfg.parser.lexer(source)
        assert.deepEqual(tokens, nativeMarked.lexer(source), source)
        assert.equal(
          tokens.map(({ raw }) => raw).join(''),
          source.replaceAll('\r\n', '\n'),
        )
      })
})

test('lazy containers retain physical reference-title columns', () => {
  for (const prefix of ['> ', '> > ', '> > > '])
    for (const eol of ['\n', '\r\n']) {
      const source = (
        prefix +
        'a\nlazy one\nlazy two\n' +
        prefix.trimEnd() +
        '\n' +
        prefix +
        '[r]: /x\n' +
        prefix +
        '\t"a | b"\n' +
        prefix +
        '--|--\n\n[r]'
      ).replaceAll('\n', eol)
      const oracle = micromark(source, {
        extensions: [gfmSyntax()],
        htmlExtensions: [gfmHtml()],
      })
      const markdown = new Marked({ gfm: true }, blockMarkdown)
      assert.equal(
        markdown.lexer(source).links.r?.title ?? null,
        /title="a \| b"/.test(oracle) ? 'a | b' : null,
        source,
      )
      assert.equal(
        markdown
          .lexer(source)
          .map(({ raw }) => raw)
          .join(''),
        source.replaceAll('\r\n', '\n'),
      )
    }
})

test('quote extensions keep physical title columns and consumed fence indentation', () => {
  for (const prefix of ['> > ', '> > > ', '> > > > '])
    for (const eol of ['\n', '\r\n']) {
      const source = (
        prefix +
        '[!NOTE]\n' +
        prefix.trimEnd() +
        '\n' +
        prefix +
        '[r]: /x\n' +
        prefix +
        '\t"a | b"\n' +
        prefix +
        '--|--\n\n[r]'
      ).replaceAll('\n', eol)
      const oracle = micromark(source, {
        extensions: [gfmSyntax()],
        htmlExtensions: [gfmHtml()],
      })
      const markdown = new Marked({ gfm: true }, alertMarkdown, blockMarkdown)
      assert.equal(
        markdown.lexer(source).links.r?.title ?? null,
        /title="a \| b"/.test(oracle) ? 'a | b' : null,
        source,
      )
      assert.equal(
        markdown.parse(source).includes('<table>'),
        oracle.includes('<table>'),
        source,
      )
      assert.equal(
        markdown
          .lexer(source)
          .map(({ raw }) => raw)
          .join(''),
        source.replaceAll('\r\n', '\n'),
      )
      for (const fence of [String.fromCharCode(96).repeat(3), '~~~']) {
        const partial = (
          prefix +
          '[!NOTE]\n' +
          prefix +
          fence +
          '\n' +
          prefix.trimEnd() +
          '\tcode\n' +
          prefix +
          fence
        ).replaceAll('\n', eol)
        assert.deepEqual(
          code(markdown.parse(partial)),
          code(micromark(partial).replaceAll('\r\n', '\n')),
          partial,
        )
        assert.equal(
          markdown
            .lexer(partial)
            .map(({ raw }) => raw)
            .join(''),
          partial.replaceAll('\r\n', '\n'),
        )
      }
      for (const spaces of [1, 2, 3])
        for (const fence of [
          String.fromCharCode(96).repeat(3),
          String.fromCharCode(96).repeat(4),
        ]) {
          const body = (
            prefix +
            '[!NOTE]\n' +
            prefix +
            ' '.repeat(spaces) +
            fence +
            '\n' +
            prefix +
            '\tcode\n' +
            prefix +
            ' '.repeat(spaces) +
            fence
          ).replaceAll('\n', eol)
          assert.deepEqual(
            code(markdown.parse(body)),
            code(micromark(body).replaceAll('\r\n', '\n')),
            body,
          )
        }
    }
})

test('re-reading a nested quote with quote extensions keeps later physical rows', () => {
  // An extension that re-reads a nested quote reads its raw text, which is
  // not the rest of the frame. Later blocks in the frame keep their rows.
  for (const sample of [
    '> > x\n>\n>\t>\t\tcode',
    '> > x\n>\n>\t>\t[!NOTE]\n>\t>\n>\t>\t\tcode\n>\t>\t\tmore',
  ])
    for (const eol of ['\n', '\r\n']) {
      const source = sample.replaceAll('\n', eol)
      const markdown = new Marked({ gfm: true }, alertMarkdown, blockMarkdown)
      assert.deepEqual(
        code(markdown.parse(source)),
        code(micromark(source).replaceAll('\r\n', '\n')),
        source,
      )
    }
})
