import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { parse } from '@babel/parser'

const displayFields = new Set([
  'label',
  'title',
  'data-tooltip',
  'description',
  'message',
  'detail',
  'tooltip',
  'placeholder',
  'aria-label',
  'alt',
  'buttonLabel',
  'confirmLabel',
  'cancelLabel',
  'emptyText',
])
const messages = new Map()
const sources = new Map()
function add(value, file) {
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text || !/\p{L}/u.test(text.replace(/\{[^}]+\}/g, ''))) return
  const id = createHash('sha256').update(text).digest('hex').slice(0, 12)
  messages.set(id, text)
  if (!sources.has(id)) sources.set(id, new Set())
  sources.get(id).add(file.replaceAll('\\', '/'))
}
function text(node) {
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'TemplateLiteral') {
    let result = node.quasis[0].value.cooked
    for (const [index, expression] of node.expressions.entries())
      result += `{${expression.type === 'Identifier' ? expression.name : `value${index + 1}`}}${node.quasis[index + 1].value.cooked}`
    return result
  }
  return null
}
function collect(node, file) {
  const value = text(node)
  if (value !== null) add(value, file)
  else if (node.type === 'JSXExpressionContainer' && node.expression)
    collect(node.expression, file)
  else if (node.type === 'ConditionalExpression') {
    collect(node.consequent, file)
    collect(node.alternate, file)
  } else if (node.type === 'ArrayExpression') {
    for (const element of node.elements) if (element) collect(element, file)
  }
}
for (const entry of await readdir('src', {
  recursive: true,
  withFileTypes: true,
})) {
  if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name)) continue
  const file = join(entry.parentPath, entry.name)
  if (file.includes('useraddons') || /\.(?:d|worker)\.ts$/.test(file)) continue
  const source = parse(await readFile(file, 'utf8'), {
    sourceType: 'module',
    plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
  })
  function visit(node, parent) {
    if (node.type === 'JSXText') add(node.value, file)
    if (
      node.type === 'JSXAttribute' &&
      displayFields.has(node.name.name) &&
      node.value
    )
      collect(node.value, file)
    if (
      node.type === 'JSXExpressionContainer' &&
      ['JSXElement', 'JSXFragment'].includes(parent?.type)
    )
      collect(node, file)
    if (node.type === 'ObjectProperty') {
      const field = node.key.name ?? node.key.value
      if (
        displayFields.has(field) ||
        field === 'buttons' ||
        (field === 'name' && /manifest\.ts$/.test(file))
      )
        collect(node.value, file)
    }
    if (
      node.type === 'NewExpression' &&
      node.callee.name === 'Error' &&
      node.arguments?.[0]
    )
      collect(node.arguments[0], file)
    if (
      node.type === 'CallExpression' &&
      /^(?:setError|setNotice|setMessage|alert)$/.test(node.callee.name) &&
      node.arguments[0]
    )
      collect(node.arguments[0], file)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child, node)
      } else if (value?.type) visit(value, node)
    }
  }
  visit(source)
}

const entries = [...messages].sort((a, b) =>
  a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
)
const outputs = {
  'locales/en.json': Object.fromEntries(entries),
  'locales/sources.json': Object.fromEntries(
    entries.map(([id]) => [id, [...sources.get(id)].sort()]),
  ),
}
let stale = false
for (const [path, data] of Object.entries(outputs)) {
  const expected = `${JSON.stringify(data, null, 2)}\n`
  if (process.argv.includes('--check')) {
    if ((await readFile(path, 'utf8').catch(() => '')) !== expected) {
      console.error(`Update ${path} with npm run copy:catalog.`)
      stale = true
    }
  } else {
    await mkdir('locales', { recursive: true })
    await writeFile(path, expected)
  }
}
if (!stale)
  console.log(
    `${messages.size} English messages indexed from ${relative('.', 'src')}.`,
  )
process.exitCode = stale ? 1 : 0
