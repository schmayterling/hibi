import assert from 'node:assert/strict'
import test from 'node:test'
import { parser } from '@lezer/markdown'
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
