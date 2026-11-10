import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from '@babel/parser'

// A page with no charset reads its scripts as windows-1252, and bundled data
// with non-ASCII text decodes to something else (#1022).
test('every harness page a test writes declares its charset before its scripts', async () => {
  const folder = new URL('./', import.meta.url)
  const pages = []
  for (const name of (await readdir(folder)).filter((name) =>
    name.endsWith('.mjs'),
  )) {
    const code = await readFile(new URL(name, folder), 'utf8')
    if (!/<script/i.test(code)) continue
    const visit = (node) => {
      if (Array.isArray(node)) return node.forEach(visit)
      if (!node || typeof node.type !== 'string') return
      const text =
        node.type === 'StringLiteral'
          ? node.value
          : node.type === 'TemplateLiteral'
            ? node.quasis.map((quasi) => quasi.value.cooked).join('')
            : null
      const script = text?.search(/<script\b[^>]*\bsrc\s*=/i) ?? -1
      if (script !== -1) {
        const charset = text.search(/<meta\s[^>]*\bcharset\s*=/i)
        pages.push({
          at: `${name}:${node.loc.start.line}`,
          declared: charset !== -1 && charset < script,
        })
      }
      for (const key in node)
        if (key !== 'loc' && typeof node[key] === 'object') visit(node[key])
    }
    visit(parse(code, { sourceType: 'module' }).program)
  }
  assert.ok(pages.length > 0, 'no harness pages found')
  assert.deepEqual(
    pages.filter((page) => !page.declared).map((page) => page.at),
    [],
  )
})
