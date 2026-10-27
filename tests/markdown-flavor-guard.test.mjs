import assert from 'node:assert/strict'
import test from 'node:test'
import { NodeProp, TreeFragment } from '@lezer/common'
import { GFM, parser } from '@lezer/markdown'
import {
  guardMarkdownSyntax,
  protectMarkdownParser,
} from '../src/shared/markdown-flavor-guard.ts'

function owner(syntax) {
  let active = true
  const errors = []
  const config = guardMarkdownSyntax(
    syntax,
    () => active,
    (error) => {
      active = false
      errors.push(error)
    },
  )
  return {
    config,
    errors,
    remove() {
      active = false
    },
  }
}

function protectedParser(configs) {
  return protectMarkdownParser(parser, configs)
}

test('malformed syntax construction is quarantined before source startup', () => {
  for (const syntax of [null, { parseInline: 'invalid' }, { props: 1 }]) {
    const bad = owner(syntax)
    const configured = protectedParser(bad.config)
    assert.equal(bad.errors.length, 1)
    assert.equal(
      configured.parse('**strong**').toString(),
      parser.parse('**strong**').toString(),
    )
  }
})

for (const [kind, syntax] of [
  [
    'inline',
    {
      defineNodes: ['InvalidInline'],
      parseInline: [
        { name: 'InvalidInline', before: 'Highlight', parse: () => -1 },
      ],
    },
  ],
  [
    'block',
    {
      defineNodes: [{ name: 'InvalidBlock', block: true }],
      parseBlock: [
        { name: 'InvalidBlock', after: 'BlockMath', parse: () => false },
      ],
    },
  ],
]) {
  test(`${kind} configure failure quarantines its owner and retains healthy syntax`, () => {
    const bad = owner(syntax)
    const good = owner({ defineNodes: ['HealthyNode'] })
    const configured = protectedParser([bad.config, good.config])
    assert.equal(
      configured.parse('**strong**').toString(),
      parser.parse('**strong**').toString(),
    )
    assert.equal(bad.errors.length, 1)
    assert.match(bad.errors[0].message, /unknown parser/)
    assert.equal(good.errors.length, 0)
    assert.ok(
      configured.nodeSet.types.some((type) => type.name === 'HealthyNode'),
    )
    configured.configure({}).parse('**again**')
    assert.equal(bad.errors.length, 1)
  })
}

test('configure recovery keeps one registration’s dependent configs together', () => {
  const good = owner([
    {
      defineNodes: ['Dependent'],
      parseInline: [{ name: 'FirstOwned', parse: () => -1 }],
    },
    {
      parseInline: [
        { name: 'SecondOwned', before: 'FirstOwned', parse: () => -1 },
      ],
    },
  ])
  const bad = owner({
    parseInline: [{ name: 'BadOrder', before: 'Missing', parse: () => -1 }],
  })
  const configured = protectedParser([good.config, bad.config])
  assert.equal(
    configured.parse('**strong**').toString(),
    parser.parse('**strong**').toString(),
  )
  assert.equal(good.errors.length, 0)
  assert.equal(bad.errors.length, 1)
})

test('derived configuration removes owned inline rules after their registration', () => {
  let calls = 0
  const extension = owner({
    parseInline: [
      {
        name: 'OwnedInlineRule',
        parse() {
          calls++
          return -1
        },
      },
    ],
  })
  const configured = protectedParser(extension.config).configure({
    remove: ['OwnedInlineRule'],
  })
  configured.parse('plain text')
  assert.equal(calls, 0)
  assert.equal(extension.errors.length, 0)
})

for (const name of ['Paragraph', 'Highlight', 'InlineMath']) {
  test(`external node collision with bundled ${name} is owned and rejected`, () => {
    const bad = owner({ defineNodes: [name] })
    const trusted = { defineNodes: ['Highlight', 'InlineMath'] }
    const configured = protectedParser([trusted, bad.config])
    assert.equal(bad.errors.length, 1)
    assert.match(bad.errors[0].message, /already defined/)
    assert.ok(bad.errors[0].message.includes(name))
    assert.equal(
      configured.parse('**strong**').toString(),
      parser.parse('**strong**').toString(),
    )
  })
}

test('a node declaration getter failure is attributed before namespace validation', () => {
  const failure = new Error('node declaration failed')
  const bad = owner({
    defineNodes: [
      {
        get name() {
          throw failure
        },
      },
    ],
  })
  const configured = protectedParser(bad.config)
  assert.deepEqual(bad.errors, [failure])
  assert.equal(
    configured.parse('**strong**').toString(),
    parser.parse('**strong**').toString(),
  )
})

test('two external owners cannot silently merge their node declarations', () => {
  const first = owner({ defineNodes: ['UniqueOwnedNode'] })
  const second = owner({ defineNodes: ['UniqueOwnedNode'] })
  const configured = protectedParser([first.config, second.config])
  assert.equal(first.errors.length, 0)
  assert.equal(second.errors.length, 1)
  assert.equal(
    configured.nodeSet.types.filter((type) => type.name === 'UniqueOwnedNode')
      .length,
    1,
  )
})

test('host GFM configs remain reusable by external flavors', () => {
  const imported = owner(GFM)
  const configured = protectMarkdownParser(
    parser.configure(GFM),
    imported.config,
  )
  assert.equal(imported.errors.length, 0)
  assert.equal(
    configured.parse('~~strike~~').toString(),
    parser.configure(GFM).parse('~~strike~~').toString(),
  )
})

for (const hook of [
  'inline',
  'block',
  'leaf',
  'nextLine',
  'finish',
  'endLeaf',
  'composite',
  'wrap',
  'advance',
  'stopAt',
  'parsedPos',
  'stoppedAt',
]) {
  test(`${hook} failure discards partial mutations and reports only its owner`, () => {
    const error = new Error(hook)
    let calls = 0
    const fail = () => {
      calls++
      throw error
    }
    const healthy = owner({
      wrap: (inner) => ({
        advance: () => inner.advance(),
        stopAt: (pos) => inner.stopAt(pos),
        get parsedPos() {
          return inner.parsedPos
        },
        get stoppedAt() {
          return inner.stoppedAt
        },
      }),
    })
    let syntax
    let source = 'first\nsecond\n\n**strong**\n'
    if (hook === 'inline')
      syntax = {
        defineNodes: ['Partial'],
        parseInline: [
          {
            name: 'Fault',
            before: 'Emphasis',
            parse(cx, _, pos) {
              cx.addElement(cx.elt('Partial', pos, pos + 1))
              return fail()
            },
          },
        ],
      }
    else if (hook === 'block')
      syntax = {
        defineNodes: [{ name: 'Partial', block: true }],
        parseBlock: [
          {
            name: 'Fault',
            before: 'ATXHeading',
            parse(cx) {
              cx.nextLine()
              cx.addElement(cx.elt('Partial', 0, 1))
              return fail()
            },
          },
        ],
      }
    else if (['leaf', 'nextLine', 'finish', 'endLeaf'].includes(hook))
      syntax = {
        parseBlock: [
          {
            name: 'Fault',
            leaf:
              hook === 'leaf'
                ? fail
                : () => ({
                    nextLine: hook === 'nextLine' ? fail : () => false,
                    finish: hook === 'finish' ? fail : () => false,
                  }),
            ...(hook === 'endLeaf' ? { endLeaf: fail } : {}),
          },
        ],
      }
    else if (hook === 'composite') {
      source = '> first\n> second\n\n**strong**\n'
      syntax = {
        defineNodes: [{ name: 'Fault', block: true, composite: fail }],
        parseBlock: [
          {
            name: 'Fault',
            before: 'Blockquote',
            parse(cx, line) {
              if (line.next !== 62) return false
              cx.startComposite('Fault', line.pos)
              line.moveBase(line.pos + 1)
              return null
            },
          },
        ],
      }
    } else
      syntax = {
        wrap:
          hook === 'wrap'
            ? fail
            : (inner) => ({
                advance: hook === 'advance' ? fail : () => inner.advance(),
                stopAt: hook === 'stopAt' ? fail : (pos) => inner.stopAt(pos),
                get parsedPos() {
                  return hook === 'parsedPos' ? fail() : inner.parsedPos
                },
                get stoppedAt() {
                  return hook === 'stoppedAt' ? fail() : inner.stoppedAt
                },
              }),
      }
    const bad = owner(syntax)
    const configured = protectedParser([healthy.config, bad.config])
    const parse = configured.startParse(source)
    if (hook === 'stopAt') parse.stopAt(source.length)
    if (hook === 'parsedPos') void parse.parsedPos
    if (hook === 'stoppedAt') void parse.stoppedAt
    let tree
    for (let steps = 0; !tree && steps < 100; steps++) tree = parse.advance()
    assert.ok(tree, 'parse must finish')
    assert.equal(tree.toString(), parser.parse(source).toString())
    assert.equal(calls, 1)
    assert.deepEqual(bad.errors, [error])
    assert.deepEqual(healthy.errors, [])
    assert.equal(configured.parse(source).toString(), tree.toString())
    assert.equal(calls, 1)
  })
}

test('quarantine restores overridden core and healthy parser rules', () => {
  const healthy = {
    defineNodes: ['Native'],
    parseInline: [
      {
        name: 'Native',
        parse(cx, next, pos) {
          return next === 126
            ? cx.addElement(cx.elt('Native', pos, pos + 1))
            : -1
        },
      },
    ],
  }
  const bad = owner({
    remove: ['Native'],
    parseInline: [
      {
        name: 'Emphasis',
        parse() {
          throw Error('override')
        },
      },
    ],
  })
  const configured = protectedParser([healthy, bad.config])
  assert.equal(
    configured.parse('**strong** ~').toString(),
    parser.configure(healthy).parse('**strong** ~').toString(),
  )
  assert.equal(bad.errors.length, 1)
})

test('standalone inline parsing retries with no partial elements', () => {
  const bad = owner({
    defineNodes: ['Partial'],
    parseInline: [
      {
        name: 'Fault',
        parse(cx, _, pos) {
          cx.addElement(cx.elt('Partial', pos, pos + 1))
          throw Error('inline')
        },
      },
    ],
  })
  const configured = protectedParser([bad.config]).configure({})
  assert.deepEqual(
    configured.parseInline('**strong**', 17),
    parser.parseInline('**strong**', 17),
  )
  assert.equal(bad.errors.length, 1)
})

test('a nested independent parser recovers without quarantining its caller', () => {
  const bad = owner({
    parseInline: [
      {
        name: 'Bad',
        parse() {
          throw Error('nested')
        },
      },
    ],
  })
  const nested = protectedParser([bad.config])
  let calls = 0
  const healthy = owner({
    parseInline: [
      {
        name: 'Healthy',
        parse() {
          assert.ok(++calls <= 2, 'nested recovery must settle')
          nested.parseInline('x', 0)
          return -1
        },
      },
    ],
  })
  const configured = protectedParser([healthy.config])
  assert.equal(configured.parse('x').toString(), parser.parse('x').toString())
  assert.equal(bad.errors.length, 1)
  assert.deepEqual(healthy.errors, [])
})

test('removing an owner during a partial parse restarts without stale wrappers', () => {
  const bad = owner({ wrap: (inner) => inner })
  const configured = protectedParser([bad.config])
  const parse = configured.startParse('one\n\ntwo\n')
  assert.equal(parse.advance(), null)
  bad.remove()
  let tree
  for (let steps = 0; !tree && steps < 100; steps++) tree = parse.advance()
  assert.ok(tree, 'parse must finish')
  assert.equal(tree.toString(), parser.parse('one\n\ntwo\n').toString())
  assert.deepEqual(bad.errors, [])
})

for (const derived of [false, true]) {
  test(`owned props failures recover during ${derived ? 'derived' : 'initial'} configuration`, () => {
    const prop = new NodeProp()
    const healthy = owner({ props: [prop.add({ Paragraph: 'healthy' })] })
    const failures = [new Error('first props'), new Error('second props')]
    const bad = failures.map((error, index) =>
      owner([
        {
          defineNodes: [`Owned${index}`],
          props: [prop.add({ Paragraph: 'partial' })],
        },
        {
          props: [
            () => {
              throw error
            },
          ],
        },
      ]),
    )
    const base = derived ? protectedParser([healthy.config]) : parser
    const configs = bad.map((item) => item.config)
    const configured = derived
      ? base.configure(configs)
      : protectMarkdownParser(base, [healthy.config, configs])
    const tree = configured.parse('**strong**')
    assert.equal(tree.toString(), parser.parse('**strong**').toString())
    assert.equal(tree.topNode.firstChild.type.prop(prop), 'healthy')
    assert.deepEqual(healthy.errors, [])
    for (const [index, item] of bad.entries()) {
      assert.deepEqual(item.errors, [failures[index]])
      assert.ok(
        configured.nodeSet.types.some((type) => type.name === `Owned${index}`),
      )
    }
  })
}

test('recovery quarantines successive props owners and discards their partial props', () => {
  const prop = new NodeProp()
  let armed = false
  const failures = [new Error('first props'), new Error('second props')]
  const bad = failures.map((error) =>
    owner({
      props: [
        prop.add((type) => {
          if (armed && type.name === 'Paragraph') throw error
          return 'partial'
        }),
      ],
    }),
  )
  const first = owner({
    parseInline: [
      {
        name: 'Fault',
        parse() {
          armed = true
          throw Error('first parser')
        },
      },
    ],
  })
  const healthy = owner({ props: [prop.add({ Paragraph: 'healthy' })] })
  const configured = protectedParser([
    healthy.config,
    ...bad.map((item) => item.config),
    first.config,
  ])
  const tree = configured.parse('**strong**')
  assert.equal(tree.toString(), parser.parse('**strong**').toString())
  assert.equal(tree.topNode.firstChild.type.prop(prop), 'healthy')
  for (const [index, item] of bad.entries())
    assert.deepEqual(item.errors, [failures[index]])
  assert.equal(first.errors.length, 1)
  assert.deepEqual(healthy.errors, [])
})

for (const reuse of [false, true]) {
  test(`quarantine discards ${reuse ? 'old fragments' : 'interleaved partial nodes'}`, () => {
    let armed = false
    const bad = owner({
      defineNodes: ['Old'],
      parseInline: [
        {
          name: 'Old',
          parse(cx, next, pos) {
            if (armed && cx.slice(cx.offset, cx.end).includes('explode'))
              throw Error('late fault')
            return next === 126
              ? cx.addElement(cx.elt('Old', pos, pos + 1))
              : -1
          },
        },
      ],
    })
    const configured = protectedParser([bad.config])
    const source = `${'~before~ **strong**\n\n'.repeat(60)}explode\n`
    const old = configured.parse(source)
    assert.match(old.toString(), /Old/)
    const a = configured.startParse(source),
      b = configured.startParse(source)
    for (let step = 0; step < 3; step++) {
      assert.equal(a.advance(), null)
      assert.equal(b.advance(), null)
    }
    const finish = (parse) => {
      let tree
      for (let step = 0; !tree && step < 500; step++) tree = parse.advance()
      assert.ok(tree, 'parse must finish')
      return tree
    }
    armed = true
    const expected = parser.parse(source).toString()
    assert.equal(finish(a).toString(), expected)
    assert.equal(
      (reuse
        ? configured.parse(source, TreeFragment.addTree(old))
        : finish(b)
      ).toString(),
      expected,
    )
    assert.equal(bad.errors.length, 1)
  })
}
