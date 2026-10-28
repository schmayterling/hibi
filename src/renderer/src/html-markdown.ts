/*
 * HTML pasted into the formatted view, as Markdown: a small walker over the
 * elements Markdown has (paragraphs, headings, emphasis, links, code, lists,
 * quotes, images, tables, rules, breaks, strikethrough). Other elements keep
 * their text; block-level ones keep their own paragraphs.
 */

import DOMPurify from 'dompurify'
import {
  markdownLineStarts as escapeLineStarts,
  markdownLiteral as literal,
} from '../../shared/markdown-literal.ts'
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

/**
 * HTTP(S) URLs first get browser path semantics. Remaining tabs and line
 * breaks drop out, backslashes cannot escape closing delimiters, and
 * spaces, controls, angle brackets and parentheses take the `<…>` form.
 */
function destination(url: string) {
  const parsed = URL.parse(url)
  if (parsed && /^https?:$/.test(parsed.protocol)) url = parsed.href
  url = url.replace(/[\t\n\r]/g, '').replace(/\\/g, '%5C')
  return /[\s()<>\p{Cc}]/u.test(url)
    ? `<${url.replace(/[<>]/g, encodeURI)}>`
    : url
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
      // A description reads as text: its blank lines must not end the paragraph.
      const alt = (element.getAttribute('alt') ?? '').replace(
        /[ \t\r\n\f]+/g,
        ' ',
      )
      return src ? `![${literal(alt)}](${destination(src)})` : ''
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

/**
 * Parse clipboard HTML, keeping only its selection. Native clipboards can wrap
 * it in a page and mark it with `<!--StartFragment-->` and
 * `<!--EndFragment-->`; as in Chromium, the first start and the last end
 * count. Only the source between them is parsed, after start tags for the
 * elements around the start, so the parser's repairs cannot bring anything
 * from outside it in, nor drop what is inside; ordered lists keep their
 * numbers.
 */
function parseSelection(html: string) {
  const parser = new DOMParser()
  const parse = (source: string) => parser.parseFromString(source, 'text/html')
  const markers = [...html.matchAll(/<!--(start|end)fragment-->/gi)]
  if (!markers.length) return parse(html)
  // Only markers the parser reads as comments count, not the same text in an
  // attribute, a textarea, CDATA, a template or another comment. A first
  // parse names each one, with names this paste alone knows, to see which.
  const id = crypto.getRandomValues(new Uint32Array(4)).join('-')
  let named = '',
    at = 0
  for (const [index, marker] of markers.entries()) {
    named += `${html.slice(at, marker.index)}<!--${id}-${index}-->`
    at = marker.index + marker[0].length
  }
  const probe = parse(named + html.slice(at))
  const read = new Map<string | null, Node>()
  const comments = probe.createTreeWalker(probe, NodeFilter.SHOW_COMMENT)
  for (let node = comments.nextNode(); node; node = comments.nextNode())
    read.set(node.nodeValue, node)
  const genuine = markers.flatMap((marker, index) => {
    const node = read.get(`${id}-${index}`)
    return node ? [{ marker, node }] : []
  })
  const start = genuine.find(({ marker }) => /^<!--s/i.test(marker[0]))
  const end =
    start &&
    genuine.findLast(
      ({ marker }) =>
        marker.index > start.marker.index && /^<!--e/i.test(marker[0]),
    )
  if (!start || !end) return parse(html)
  let context = ''
  const { body } = probe
  if (body?.contains(start.node))
    for (
      let child = start.node;
      child.parentNode !== body;
      child = child.parentNode as Node
    ) {
      const element = child.parentNode as Element
      const open = element.cloneNode(false) as Element
      if (open instanceof HTMLOListElement) {
        let items = 0
        for (
          let item = child.previousSibling;
          item;
          item = item.previousSibling
        )
          if (item.nodeName === 'LI') items++
        open.start = (element as HTMLOListElement).start + items
      }
      const tags = open.outerHTML
      context = tags.slice(0, tags.lastIndexOf('</')) + context
    }
  return parse(
    context +
      // The start comment stays first, so a `<pre>` around it cannot take the
      // selection's leading line break for its own.
      html.slice(start.marker.index, end.marker.index),
  )
}

/** Markdown for pasted HTML. */
export function htmlToMarkdown(html: string, original?: string) {
  const document = parseSelection(html)
  if (
    original !== undefined &&
    document.body.firstElementChild?.hasAttribute('data-hibi-markdown')
  )
    return original
  DOMPurify.sanitize(document.body, { ...renderedHtmlOptions, IN_PLACE: true })
  return blocksOf(document.body).join('\n\n')
}
