/*
 * HTML pasted into the formatted view, as Markdown: a small walker over the
 * elements Markdown has (paragraphs, headings, emphasis, links, code, lists,
 * quotes, images, tables, rules, breaks, strikethrough). Other elements keep
 * their text; block-level ones keep their own paragraphs.
 */

const blocks = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'UL',
])
const skipped = new Set(['HEAD', 'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'])

const isBlock = (node: Node) =>
  node.nodeType === Node.ELEMENT_NODE && blocks.has(node.nodeName)
const hasBlocks = (node: Node) => [...node.childNodes].some(isBlock)

/** Text that reads as itself in Markdown. */
function literal(text: string) {
  return text.replace(/[\\`*_[\]<]/g, '\\$&')
}

/** Line starts that would begin a block. */
function escapeLineStarts(text: string) {
  return text
    .replace(/^( {0,3})(\d{1,9})([.)])/gm, '$1$2\\$3')
    .replace(/^( {0,3})([#>+=-])/gm, '$1\\$2')
}

/** Wrap inline content in a delimiter, keeping its outer spaces outside. */
function wrap(content: string, mark: string) {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(content)
  const [, before = '', inner = '', after = ''] = match ?? []
  return inner ? `${before}${mark}${inner}${mark}${after}` : content
}

/** Inline code with a fence longer than any backtick run inside it. */
function code(text: string) {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  )
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

function destination(url: string) {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, encodeURI)}>` : url
}

/** Inline Markdown of a node's children; `cell` writes breaks as `<br>`. */
function inline(node: Node, cell = false): string {
  let out = ''
  for (const child of node.childNodes) out += inlineNode(child, cell)
  return out
}

function inlineNode(node: Node, cell: boolean): string {
  if (node.nodeType === Node.TEXT_NODE)
    return literal((node.textContent ?? '').replace(/\s+/g, ' '))
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const element = node as Element
  if (skipped.has(element.nodeName)) return ''
  switch (element.nodeName) {
    case 'STRONG':
    case 'B':
      return wrap(inline(element, cell), '**')
    case 'EM':
    case 'I':
      return wrap(inline(element, cell), '*')
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return wrap(inline(element, cell), '~~')
    case 'CODE':
      return code(element.textContent ?? '')
    case 'A': {
      const href = element.getAttribute('href')
      const text = inline(element, cell)
      return href ? `[${text}](${destination(href)})` : text
    }
    case 'IMG': {
      const src = element.getAttribute('src')
      return src
        ? `![${literal(element.getAttribute('alt') ?? '')}](${destination(src)})`
        : ''
    }
    case 'BR':
      return cell ? '<br>' : '  \n'
    default:
      // A block inside inline content keeps its text, set apart by spaces.
      return blocks.has(element.nodeName)
        ? ` ${inline(element, cell)} `
        : inline(element, cell)
  }
}

/** A paragraph's text: trimmed lines, with line starts that stay text. */
function paragraph(text: string) {
  return escapeLineStarts(
    text
      .split('\n')
      .map((line) => line.replace(/^ +/, '').replace(/(?<! ) $/, ''))
      .join('\n')
      .trim(),
  )
}

/** Markdown blocks of a node's children. */
function blocksOf(node: Node): string[] {
  const out: string[] = []
  let run = ''
  const flush = () => {
    const text = paragraph(run)
    if (text) out.push(text)
    run = ''
  }
  for (const child of node.childNodes) {
    if (isBlock(child)) {
      flush()
      out.push(...block(child as Element))
    } else run += inlineNode(child, false)
  }
  flush()
  return out
}

const indent = (text: string, prefix: string, first = prefix) =>
  text
    .split('\n')
    .map((line, index) =>
      line ? (index ? prefix : first) + line : line.trimEnd(),
    )
    .join('\n')

function block(element: Element): string[] {
  const name = element.nodeName
  if (/^H[1-6]$/.test(name)) {
    const text = inline(element)
      .replace(/\s*\n\s*/g, ' ')
      .trim()
    return text ? [`${'#'.repeat(Number(name[1]))} ${text}`] : []
  }
  switch (name) {
    case 'P':
      return hasBlocks(element)
        ? blocksOf(element)
        : [paragraph(inline(element))].filter(Boolean)
    case 'HR':
      return ['---']
    case 'PRE': {
      const source = element.querySelector('code') ?? element
      const language =
        /(?:^|\s)(?:language|lang)-(\S+)/.exec(
          `${source.getAttribute('class') ?? ''} ${element.getAttribute('class') ?? ''}`,
        )?.[1] ?? ''
      const text = (element.textContent ?? '').replace(/\n$/, '')
      const longest = Math.max(
        2,
        ...(text.match(/^`+/gm) ?? []).map((run) => run.length),
      )
      const fence = '`'.repeat(longest + 1)
      return [`${fence}${language}\n${text}\n${fence}`]
    }
    case 'BLOCKQUOTE':
      return [indent(blocksOf(element).join('\n\n'), '> ').replace(/^$/gm, '>')]
    case 'UL':
    case 'OL':
      return [list(element)].filter(Boolean)
    case 'TABLE':
      return [table(element)].filter(Boolean)
    default:
      return blocksOf(element)
  }
}

function list(element: Element): string {
  const ordered = element.nodeName === 'OL'
  let number = Number(element.getAttribute('start') ?? 1) || 1
  const items: string[] = []
  for (const child of element.children) {
    if (child.nodeName !== 'LI') continue
    const marker = ordered ? `${number++}. ` : '- '
    const content = blocksOf(child)
    const checkbox = child.querySelector(':scope > input[type="checkbox"]')
    const task = checkbox
      ? `[${(checkbox as HTMLInputElement).checked ? 'x' : ' '}] `
      : ''
    // A list right after an item's text stays tight under it.
    const text = content.reduce(
      (out, next, index) =>
        index
          ? `${out}${/^(?:- |\d+\. )/.test(next) ? '\n' : '\n\n'}${next}`
          : next,
      '',
    )
    items.push(
      indent(`${task}${text}`, ' '.repeat(marker.length), marker) || marker,
    )
  }
  return items.join('\n')
}

function table(element: Element): string {
  const rows = [...element.querySelectorAll('tr')].filter(
    (row) => row.closest('table') === element,
  )
  if (!rows.length) return ''
  const cells = rows.map((row) =>
    [...row.children]
      .filter((cell) => cell.nodeName === 'TD' || cell.nodeName === 'TH')
      .map((cell) =>
        inline(cell, true).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'),
      ),
  )
  const width = Math.max(...cells.map((row) => row.length))
  if (!width) return ''
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ')} |`
  const [head = [], ...body] = cells
  return [line(head), line(Array(width).fill('---')), ...body.map(line)].join(
    '\n',
  )
}

/** Markdown for pasted HTML. */
export function htmlToMarkdown(html: string) {
  const document = new DOMParser().parseFromString(html, 'text/html')
  return blocksOf(document.body).join('\n\n')
}
