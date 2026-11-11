import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import { harnessPage } from './harness-page.mjs'

const folder = fileURLToPath(new URL('./', import.meta.url))
const builder = 'harness-page.mjs'

/**
 * Lines that write a script tag a page loads, or a script tag left open for
 * a later string to finish, anywhere but the page builder. Inline script text
 * in notes, closed in the same string, is fine. Strings are read as the
 * program sees them: escapes decoded, and literal-only joins and templates
 * read whole. Pages built from values the source doesn't spell out (variables,
 * calls, JSON) are beyond it.
 */
function pagesOutsideBuilder(name, code) {
  if (/\.html?$/i.test(name))
    return [...code.matchAll(/<script\b[^>]*\bsrc\b/gi)].map(
      (match) => `${name}:${code.slice(0, match.index).split('\n').length}`,
    )
  const found = new Set()
  const folded = new Map()
  // The text a literal-only expression always makes; null for anything else.
  const fold = (node) => {
    if (folded.has(node)) return folded.get(node)
    let text = null
    if (node.type === 'StringLiteral') text = node.value
    else if (node.type === 'TemplateElement') text = node.value.cooked ?? null
    else if (node.type === 'TemplateLiteral') {
      const parts = node.expressions.map(fold)
      if (parts.every((part) => part !== null))
        text = node.quasis
          .map(
            (quasi, index) => (quasi.value.cooked ?? '') + (parts[index] ?? ''),
          )
          .join('')
    } else if (node.type === 'BinaryExpression' && node.operator === '+') {
      const left = fold(node.left)
      const right = left === null ? null : fold(node.right)
      if (right !== null) text = left + right
    } else if (node.type === 'ParenthesizedExpression')
      text = fold(node.expression)
    folded.set(node, text)
    return text
  }
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node.type !== 'string') return
    const text = fold(node)
    if (
      text !== null &&
      [...text.matchAll(/<script\b/gi)].some((match) => {
        const tag = /^[^>]*>/.exec(text.slice(match.index))
        return !tag || /\bsrc\b/i.test(tag[0])
      })
    )
      found.add(`${name}:${node.loc.start.line}`)
    for (const key in node)
      if (key !== 'loc' && typeof node[key] === 'object') visit(node[key])
  }
  visit(
    parse(code, {
      sourceType: 'unambiguous',
      plugins: /\.tsx?$/.test(name)
        ? ['typescript', ...(name.endsWith('x') ? ['jsx'] : [])]
        : [],
    }).program,
  )
  return [...found]
}

test('every page a test writes for a window comes from the page builder', async () => {
  const found = []
  for (const entry of await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  })) {
    const path = relative(folder, join(entry.parentPath, entry.name))
    if (
      !entry.isFile() ||
      path === builder ||
      !/\.(?:[cm]?js|tsx?|html?)$/i.test(entry.name)
    )
      continue
    const code = await readFile(join(folder, path), 'utf8')
    found.push(...pagesOutsideBuilder(path, code))
  }
  assert.deepEqual(found, [])
})

test('the page check sees pages built from pieces and pages on disk', () => {
  // Cases spell the tag <%s so this file holds no page of its own.
  const tag = `${String.fromCharCode(60)}script`
  const flagged = (code, name = 'case.mjs') =>
    pagesOutsideBuilder(name, code.replaceAll('<%s', tag)).length > 0
  for (const code of [
    `const html = '<meta charset="utf-8"><%s src="good.js"></script>'`,
    `const html = '<meta charset="utf-8">' + '<%s src="x.js"></script>'`,
    `const html = '<%s ' + 'src="x.js"></script>'`,
    `const html = \`<%s \${'src'}="x.js"></script>\``,
    `const html = '<!-- <meta charset="utf-8"> --><%s src="x.js"></script>'`,
    `const html = '\\x3cscript src="harness.js"></script>'`,
    'const html = `\\u003cscript src="harness.js"></script>`',
    `const html = '<scr' + 'ipt src="harness.js"></script>'`,
  ])
    assert.equal(flagged(code), true, code)
  assert.equal(
    flagged('<!doctype html><%s src="x.js"></script>', 'fixtures/a.html'),
    true,
  )
  for (const code of [
    `const note = '<%s>window.compromised = true</script>'`,
    `const site = '<%s id="workspace-data" type="application/json">x</script>'`,
    `const body = \`<%s>\\n\${code}\\n</script>\``,
    `const html = harnessPage({ css: 'harness.css' })`,
  ])
    assert.equal(flagged(code), false, code)
  assert.match(
    harnessPage(),
    /^<!doctype html><html lang="en"><head><meta charset="utf-8">/,
  )
})
