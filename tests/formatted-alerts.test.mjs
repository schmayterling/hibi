import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import { ChunkedMarkdownParser } from '../src/renderer/src/chunked-markdown.ts'

// Feature modules import their styles; these tests need only the code.
registerHooks({
  load: (url, context, next) =>
    url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : next(url, context),
})
const { contribution, GithubAlerts } = await import(
  '../src/addons/markdown/formatted.ts'
)

const markdown = parser.configure([GFM, GithubAlerts])
const titles = (doc) => {
  const out = []
  markdown.parse(doc).iterate({
    enter(node) {
      if (['AlertTitle', 'AlertMark', 'Paragraph'].includes(node.name))
        out.push(
          `${node.name}:${JSON.stringify(doc.slice(node.from, node.to))}`,
        )
    },
  })
  return out
}

test('a quote whose first line is [!type] starts with an alert title', () => {
  assert.deepEqual(titles('> [!NOTE]\n> body'), [
    'AlertTitle:"[!NOTE]"',
    'AlertMark:"[!NOTE]"',
    'Paragraph:"body"',
  ])
  assert.deepEqual(titles('> [!tip]- Custom title\n> body\n>\n> more'), [
    'AlertTitle:"[!tip]- Custom title"',
    'AlertMark:"[!tip]-"',
    'Paragraph:"body"',
    'Paragraph:"more"',
  ])
  assert.deepEqual(titles('> [!WARNING]'), [
    'AlertTitle:"[!WARNING]"',
    'AlertMark:"[!WARNING]"',
  ])
  // Nested quotes and quotes in list items.
  assert.deepEqual(titles('> > [!NOTE]\n> > x'), [
    'AlertTitle:"[!NOTE]"',
    'AlertMark:"[!NOTE]"',
    'Paragraph:"x"',
  ])
  assert.deepEqual(titles('- > [!NOTE]\n  > x').slice(0, 1), [
    'AlertTitle:"[!NOTE]"',
  ])
  // Only the quote's first line, and only in quotes.
  for (const text of [
    '> text\n> [!NOTE]',
    '>\n> [!NOTE]',
    '[!NOTE]',
    '- [!NOTE]',
    '> [! NOTE]',
  ])
    assert.ok(
      !titles(text).some((entry) => entry.startsWith('AlertTitle')),
      text,
    )
})

test('chunked parses keep alert titles where whole-document parses put them', () => {
  const units = [
    '> [!NOTE]\n> body',
    '> [!tip] Title\n> - item',
    '> plain quote\n> [!NOTE] not a title',
    '- > [!CAUTION]\n  > x',
    'paragraph',
    '> > [!important]',
  ]
  const chunked = new ChunkedMarkdownParser(markdown, markdown, {
    chunkSize: 16,
    groupSize: 3,
  })
  const names = (tree) => {
    const out = []
    tree.iterate({
      enter(node) {
        if (node.type.name) out.push(`${node.name}:${node.from}-${node.to}`)
      },
    })
    return out
  }
  for (let seed = 0; seed < 40; seed++) {
    const text = Array.from(
      { length: 30 },
      (_, i) => units[(i * 5 + seed) % units.length],
    ).join(seed % 2 ? '\n\n' : '\n')
    assert.deepEqual(
      names(chunked.parse(text)),
      names(markdown.parse(text)),
      `seed ${seed}`,
    )
  }
})

test('the title line shows the type or its title, and its source while revealed', () => {
  const view = contribution.views.find((view) =>
    view.nodes.includes('AlertTitle'),
  )
  assert.deepEqual(view.space, { top: 0, bottom: 8 })
  const render = (doc, revealed) => {
    const state = EditorState.create({ doc })
    const out = []
    markdown.parse(doc).iterate({
      enter(node) {
        if (!view.nodes.includes(node.name)) return
        view.decorate(
          node,
          {
            mark: (from, to, attributes) =>
              out.push(['mark', doc.slice(from, to), attributes.class]),
            syntax() {},
            line: (at, attributes) => out.push(['line', at, attributes.class]),
            widget() {},
            replace: (from, to, widget) =>
              out.push(['title', doc.slice(from, to), widget.text]),
          },
          { state, revealed },
        )
      },
    })
    return out
  }
  assert.deepEqual(render('> [!NOTE]\n> body', false), [
    ['line', 0, 'hibi-lp-alert-title'],
    ['title', '[!NOTE]', 'note'],
  ])
  assert.deepEqual(render('> [!Tip] Read this\n> body', false), [
    ['line', 0, 'hibi-lp-alert-title'],
    ['title', '[!Tip] Read this', 'Read this'],
  ])
  assert.deepEqual(render('> [!Tip] Read this', true), [
    ['line', 0, 'hibi-lp-alert-title'],
    ['mark', '[!Tip]', 'hibi-lp-marker'],
  ])
})

test('only minus callouts hide their bodies by default, leaving title lines intact', () => {
  const [box] = contribution.views
  for (const fold of ['-', '+', '']) {
    const doc = `> [!note]${fold} Title\n> body\n>\n> - item`
    const state = EditorState.create({
      doc,
      extensions: contribution.extension,
    })
    const hidden = []
    markdown.parse(doc).iterate({
      enter(node) {
        if (node.name === 'Blockquote')
          return box.layout(
            node,
            {
              replace: (from, to, _widget, options) =>
                hidden.push({
                  text: state.sliceDoc(from, to),
                  block: options?.block,
                }),
            },
            { state },
          )
      },
    })
    assert.deepEqual(
      hidden,
      fold === '-' ? [{ text: '\n> body\n>\n> - item', block: true }] : [],
    )
    assert.equal(state.doc.toString(), doc)
  }
})

test('alert quotes lay out as the alerts.css box; other quotes keep their bar', () => {
  const [box] = contribution.views
  const shape = (doc) => {
    const state = EditorState.create({ doc })
    const shapes = []
    markdown.parse(doc).iterate({
      enter(node) {
        if (box.nodes.includes(node.name))
          shapes.push(
            box.container(node, { state, revealed: false, visible: null }),
          )
      },
    })
    return shapes
  }
  const [tip] = shape('> [!TIP] Read\n> body')
  assert.equal(tip.width, '19px')
  assert.equal(tip.class, 'hibi-lp-alert hibi-lp-alert-tip')
  assert.deepEqual(tip.padding, { top: 12, bottom: 12, right: 16 })
  // Inside the padding of the containers around it, right and below.
  const paint = tip.paint('24px', '16px', '16px', '12px')
  assert.match(paint, /24px 16px \/ 3px calc\(100% - 16px - 12px\)/)
  assert.match(
    paint,
    /24px 16px \/ calc\(100% - 24px - 16px\) calc\(100% - 16px - 12px\)/,
  )
  assert.deepEqual(shape('> plain quote\n> [!NOTE] text'), [undefined])
  // A nested alert lays out its own box inside the outer quote.
  const nested = shape('> outer\n>\n> > [!caution]\n> > inner')
  assert.equal(nested[0], undefined)
  assert.equal(nested[1].class, 'hibi-lp-alert hibi-lp-alert-caution')
})
