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
 * program sees them, escapes decoded, and text spelled in adjacent literals of
 * one join or template is read as one, even next to a variable. Pages built
 * from text the source doesn't spell out (variables, calls such as String.raw
 * with an invalid escape, JSON) are beyond it; String.raw`\x3cscript src` is
 * read decoded, a false alarm. `work.scanned` counts the characters read.
 */
function pagesOutsideBuilder(name, code, work = { scanned: 0 }) {
  if (/\.html?$/i.test(name))
    return [...code.matchAll(/<script\b[^>]*\bsrc\b/gi)].map(
      (match) => `${name}:${code.slice(0, match.index).split('\n').length}`,
    )
  const found = new Set()
  const check = (text, node) => {
    work.scanned += text.length
    if (
      [...text.matchAll(/<script\b/gi)].some((match) => {
        const tag = /^[^>]*>/.exec(text.slice(match.index))
        return !tag || /\bsrc\b/i.test(tag[0])
      })
    )
      found.add(`${name}:${node.loc.start.line}`)
  }
  const joins = (node) =>
    node.type === 'StringLiteral' ||
    node.type === 'TemplateLiteral' ||
    (node.type === 'BinaryExpression' && node.operator === '+')
  // The text a join or template spells, with null where a value goes.
  const pieces = (node, out) => {
    if (node.type === 'StringLiteral') out.push(node.value)
    else if (node.type === 'TemplateLiteral')
      node.quasis.forEach((quasi, index) => {
        out.push(quasi.value.cooked ?? null)
        if (index < node.expressions.length)
          pieces(node.expressions[index], out)
      })
    else if (joins(node)) {
      pieces(node.left, out)
      pieces(node.right, out)
    } else {
      out.push(null)
      visit(node)
    }
    return out
  }
  // Each literal is read once, in the longest run of text around it.
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node.type !== 'string') return
    if (joins(node)) {
      let run = ''
      for (const piece of [...pieces(node, []), null])
        if (piece !== null) run += piece
        else if (run) {
          check(run, node)
          run = ''
        }
      return
    }
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
    `const html = head + '<scr' + 'ipt src="x.js"></script>'`,
    `const html = \`\${head}<scr\` + \`ipt src="x.js"></script>\``,
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
  // A long join is read once, not once per piece.
  const work = { scanned: 0 }
  const long = `const html = ${"'a' + ".repeat(4096)}'${tag} src="x.js"></script>'`
  assert.equal(pagesOutsideBuilder('long.mjs', long, work).length, 1)
  assert.ok(
    work.scanned < long.length,
    `read ${work.scanned} of ${long.length}`,
  )
  assert.match(
    harnessPage(),
    /^<!doctype html><html lang="en"><head><meta charset="utf-8">/,
  )
})
