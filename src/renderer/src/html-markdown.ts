/*
 * HTML pasted into the formatted view, as Markdown: a small walker over the
 * elements Markdown has (paragraphs, headings, emphasis, links, code, lists,
 * quotes, images, tables, rules, breaks, strikethrough). Other elements keep
 * their text; block-level ones keep their own paragraphs.
 */

import DOMPurify from 'dompurify'
import { renderedHtmlOptions } from '../../shared/rendered-html.ts'

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

/**
 * Text that reads as itself in Markdown, whichever flavors the note uses now
 * or later: delimiters (strikethrough and subscript `~`, math `$`, highlight
 * `==`) and entity references are escaped too.
 */
function literal(text: string) {
  return (
    text
      .replace(/[\\`*_[\]<~$]/g, '\\$&')
      .replace(/&(?=#?\w+;)/g, '\\&')
      .replace(/=(?==)/g, '\\=')
      // Character references preserve Unicode spaces through Markdown trimming.
      .replace(/[^\S \t\r\n\f]/gu, (space) => `&#${space.codePointAt(0)};`)
  )
}

/** Line starts that would begin a block. */
function escapeLineStarts(text: string) {
  return text
    .replace(/^( {0,3})(\d{1,9})([.)])/gm, '$1$2\\$3')
    .replace(/^( {0,3})([#>+=-])/gm, '$1\\$2')
}

/** Wrap inline content in a delimiter, keeping its outer spaces outside. */
function wrap(content: string, mark: string) {
  const start = content.length - content.trimStart().length,
    end = content.trimEnd().length
  return start < end
    ? `${content.slice(0, start)}${mark}${content.slice(start, end)}${mark}${content.slice(end)}`
    : content
}

/** Inline code with a fence longer than any backtick run inside it. */
function code(text: string) {
  text = text.replace(/\r\n?|\n/g, ' ')
  let longest = 0
  for (const run of text.match(/`+/g) ?? [])
    longest = Math.max(longest, run.length)
  const fence = '`'.repeat(longest + 1)
  const pad =
    text.startsWith('`') ||
    text.endsWith('`') ||
    (text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text))
      ? ' '
      : ''
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
    return literal((node.textContent ?? '').replace(/[ \t\r\n\f]+/g, ' '))
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
      for (const item of block(child as Element)) out.push(item)
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
      .replace(/\n/g, ' ')
      .trim()
      .replace(/(^|[ \t])#+$/, (tail) => tail.replace(/#/g, '\\#'))
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
      // Longer than any line that could close it.
      let longest = 2
      for (const [, run = ''] of text.matchAll(/^ {0,3}(`+|~+)/gm))
        longest = Math.max(longest, run.length)
      const fence = (language.includes('`') ? '~' : '`').repeat(longest + 1)
      return [
        `${fence}${language[0] === fence[0] ? ' ' : ''}${language}\n${text}\n${fence}`,
      ]
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
    // The item's own checkbox, also inside a wrapper such as a label.
    const checkbox = child.querySelector('input[type="checkbox"]')
    const task =
      checkbox?.closest('li') === child
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
        inline(cell, true).replace(/\n/g, ' ').trim().replace(/\|/g, '\\|'),
      ),
  )
  let width = 0
  for (const row of cells) width = Math.max(width, row.length)
  if (!width) return ''
  const line = (row: string[]) => `| ${row.join(' | ')} |`
  // The header row sets the column count; shorter body rows end early.
  const [head = [], ...body] = cells
  return [
    line(Array.from({ length: width }, (_, index) => head[index] ?? '')),
    line(Array(width).fill('---')),
    ...body.map(line),
  ].join('\n')
}

/** Markdown for pasted HTML. */
export function htmlToMarkdown(html: string, original?: string) {
  const document = new DOMParser().parseFromString(html, 'text/html')
  if (
    original !== undefined &&
    document.body.firstElementChild?.hasAttribute('data-hibi-markdown')
  )
    return original
  DOMPurify.sanitize(document.body, { ...renderedHtmlOptions, IN_PLACE: true })
  return blocksOf(document.body).join('\n\n')
}
