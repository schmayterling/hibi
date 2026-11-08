// Obsidian theme and snippet CSS is untrusted data. This tokenizes it the way
// CSS Syntax Level 3 does, so escaped names such as `\75rl(` or `@\69mport`
// are seen as the browser sees them, keeps rules it can check, and writes every
// URL back out in a form of its own. Nothing here fetches or runs anything.

export const SANITIZER_VERSION = 1
export const MAX_THEME_BYTES = 5 * 1024 * 1024
export const MAX_SNIPPET_BYTES = 1024 * 1024
export const MAX_ASSET_BYTES = 2 * 1024 * 1024

type TokenType =
  | 'ws'
  | 'comment'
  | 'string'
  | 'bad-string'
  | 'url'
  | 'bad-url'
  | 'function'
  | 'ident'
  | 'at'
  | 'hash'
  | 'delim'
  | 'number'
  | 'cdo'
  | 'cdc'
  | ':'
  | ';'
  | ','
  | '['
  | ']'
  | '('
  | ')'
  | '{'
  | '}'
type Token = { type: TokenType; raw: string; value: string }
type Block = {
  type: 'block'
  open: Token
  children: Node[]
  close: string
}
type Node = Token | Block

export type DroppedRule = { rule: string; reason: string }
export type SanitizeResult = {
  css: string
  dropped: DroppedRule[]
  /** Relative asset paths referenced from the CSS, in source order. */
  assets: string[]
  /** Obsidian class atoms rewritten to also match Hibi's elements. */
  aliased: number
}
export type SanitizeOptions = {
  maxBytes?: number
  /** Data URLs for the theme's own assets, keyed by their normalized relative path. */
  assets?: ReadonlyMap<string, string>
}

const hex = /^[\da-f]$/i
const digit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'
const nameStart = (c: string | undefined) =>
  c !== undefined && (/[a-z_]/i.test(c) || c.charCodeAt(0) >= 0x80)
const nameChar = (c: string | undefined) =>
  c !== undefined && (nameStart(c) || digit(c) || c === '-')
const space = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n'
const validEscape = (s: string, i: number) =>
  s[i] === '\\' && s[i + 1] !== undefined && s[i + 1] !== '\n'
const startsIdent = (s: string, i: number) =>
  s[i] === '-'
    ? nameStart(s[i + 1]) || s[i + 1] === '-' || validEscape(s, i + 1)
    : nameStart(s[i]) || validEscape(s, i)
const startsNumber = (s: string, i: number) =>
  s[i] === '+' || s[i] === '-'
    ? digit(s[i + 1]) || (s[i + 1] === '.' && digit(s[i + 2]))
    : s[i] === '.'
      ? digit(s[i + 1])
      : digit(s[i])

function readEscape(s: string, i: number): [string, number] {
  // i points after the backslash
  if (i >= s.length) return ['�', i]
  if (hex.test(s[i] as string)) {
    let end = i
    while (end < s.length && end - i < 6 && hex.test(s[end] as string)) end++
    const code = Number.parseInt(s.slice(i, end), 16)
    if (space(s[end])) end++
    const valid =
      code !== 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
    return [valid ? String.fromCodePoint(code) : '�', end]
  }
  const char = String.fromCodePoint(s.codePointAt(i) as number)
  return [char, i + char.length]
}

function name(s: string, i: number): [string, number] {
  let value = ''
  while (i < s.length) {
    if (nameChar(s[i])) value += s[i++]
    else if (validEscape(s, i)) {
      const [char, next] = readEscape(s, i + 1)
      value += char
      i = next
    } else break
  }
  return [value, i]
}

export function tokenize(input: string): Token[] {
  const s = input.replace(/\r\n?|\f/g, '\n').replace(/\0/g, '�')
  const tokens: Token[] = []
  let i = 0
  const push = (type: TokenType, start: number, value = '') =>
    tokens.push({ type, raw: s.slice(start, i), value })
  while (i < s.length) {
    const start = i
    const c = s[i] as string
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2)
      i = end < 0 ? s.length : end + 2
      push('comment', start)
    } else if (space(c)) {
      while (space(s[i])) i++
      push('ws', start)
    } else if (c === '"' || c === "'") {
      i++
      let value = ''
      let type: TokenType = 'string'
      while (i < s.length) {
        const d = s[i] as string
        if (d === c) {
          i++
          break
        }
        if (d === '\n') {
          type = 'bad-string'
          break
        }
        if (d === '\\') {
          if (s[i + 1] === undefined) i++
          else if (s[i + 1] === '\n') i += 2
          else {
            const [char, next] = readEscape(s, i + 1)
            value += char
            i = next
          }
        } else {
          value += d
          i++
        }
      }
      push(type, start, value)
    } else if (c === '#' && (nameChar(s[i + 1]) || validEscape(s, i + 1))) {
      const [value, next] = name(s, i + 1)
      i = next
      push('hash', start, value)
    } else if ('()[]{},:;'.includes(c)) {
      i++
      push(c as TokenType, start)
    } else if (
      (c === '+' || c === '.' || c === '-' || digit(c)) &&
      startsNumber(s, i)
    ) {
      if (s[i] === '+' || s[i] === '-') i++
      while (digit(s[i])) i++
      if (s[i] === '.' && digit(s[i + 1])) {
        i++
        while (digit(s[i])) i++
      }
      if (
        (s[i] === 'e' || s[i] === 'E') &&
        (digit(s[i + 1]) ||
          ((s[i + 1] === '+' || s[i + 1] === '-') && digit(s[i + 2])))
      ) {
        i += 2
        while (digit(s[i])) i++
      }
      if (startsIdent(s, i)) i = name(s, i)[1]
      else if (s[i] === '%') i++
      push('number', start)
    } else if (c === '-' && s[i + 1] === '-' && s[i + 2] === '>') {
      i += 3
      push('cdc', start)
    } else if (c === '<' && s.startsWith('<!--', i)) {
      i += 4
      push('cdo', start)
    } else if (c === '@' && startsIdent(s, i + 1)) {
      const [value, next] = name(s, i + 1)
      i = next
      push('at', start, value.toLowerCase())
    } else if (startsIdent(s, i)) {
      const [value, next] = name(s, i)
      i = next
      if (s[i] !== '(') push('ident', start, value)
      else if (value.toLowerCase() !== 'url') {
        i++
        push('function', start, value.toLowerCase())
      } else {
        i++
        let j = i
        while (space(s[j])) j++
        if (s[j] === '"' || s[j] === "'") push('function', start, 'url')
        else url(start, j)
      }
    } else {
      i += String.fromCodePoint(s.codePointAt(i) as number).length
      push('delim', start, c)
    }
  }
  function url(start: number, from: number) {
    i = from
    let value = ''
    let bad = false
    while (i < s.length) {
      const d = s[i] as string
      if (d === ')') {
        i++
        break
      }
      if (space(d)) {
        while (space(s[i])) i++
        if (s[i] === ')' || i >= s.length) continue
        bad = true
      } else if (
        d === '"' ||
        d === "'" ||
        d === '(' ||
        d.charCodeAt(0) < 0x20 ||
        d.charCodeAt(0) === 0x7f
      )
        bad = true
      else if (d === '\\') {
        if (!validEscape(s, i)) bad = true
        else {
          const [char, next] = readEscape(s, i + 1)
          value += char
          i = next
          continue
        }
      } else {
        value += d
        i++
        continue
      }
      if (bad) {
        while (i < s.length && s[i] !== ')') {
          if (validEscape(s, i)) i = readEscape(s, i + 1)[1]
          else i++
        }
        if (s[i] === ')') i++
        break
      }
    }
    push(bad ? 'bad-url' : 'url', start, value)
  }
  return tokens
}

const closer: Record<string, string> = { '{': '}', '[': ']', '(': ')' }

function tree(tokens: Token[]): Node[] {
  let i = 0
  const read = (end: string | null): Node[] => {
    const nodes: Node[] = []
    while (i < tokens.length) {
      const token = tokens[i++] as Token
      if (token.type === end) return nodes
      if (token.type === '{' || token.type === '[' || token.type === '(') {
        const close = closer[token.type] as string
        nodes.push({ type: 'block', open: token, children: read(close), close })
      } else if (token.type === 'function')
        nodes.push({
          type: 'block',
          open: token,
          children: read(')'),
          close: ')',
        })
      // Stray closers are dropped so the output stays balanced.
      else if (token.type !== '}' && token.type !== ']' && token.type !== ')')
        nodes.push(token)
    }
    return nodes
  }
  return read(null)
}

const serialize = (nodes: readonly Node[]): string =>
  nodes
    .map((node) =>
      node.type === 'block'
        ? node.open.raw + serialize(node.children) + node.close
        : node.raw,
    )
    .join('')

const isBlock = (node: Node | undefined, open?: string): node is Block =>
  node?.type === 'block' && (open === undefined || node.open.type === open)
const trivia = (node: Node) => node.type === 'ws' || node.type === 'comment'
const brief = (text: string) => {
  const clean = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean
}

/** Obsidian class → Hibi selector that plays the same part. */
export const SELECTOR_ALIASES: Readonly<Record<string, string>> = {
  'app-container': '.app',
  workspace: '.app',
  'workspace-split': '.editor-content',
  'mod-root': '.editor-content',
  'workspace-leaf': '.editor-panes',
  'workspace-leaf-content': '.editor-panes',
  'view-content': '.editor-content',
  'workspace-tabs': '.document-tabs',
  'workspace-tab-header-container': '.document-tabs',
  'workspace-tab-header': '.document-tab',
  'view-header': '.titlebar',
  titlebar: '.titlebar',
  'view-header-title': '.document-title',
  'mod-left-split': '.workspace-sidebar',
  'nav-files-container': '.workspace-sidebar',
  'nav-file-title': '.workspace-sidebar .sidebar-row',
  'nav-folder-title': '.workspace-sidebar .sidebar-row',
  'tree-item-self': '.sidebar-row',
  'status-bar': '.app-statusbar',
  'status-bar-item': '.status-pill',
  menu: '.ui-menu',
  'suggestion-container': '.cm-tooltip-autocomplete',
  // Pairs, so the copy catalog doesn't take these selectors for interface text.
  ...Object.fromEntries([
    ['tooltip', '.ui-tooltip'],
    ['notice', '.document-notice'],
  ]),
  'markdown-source-view': ':is(.formatted-editor, .source-editor)',
  'mod-cm6': ':is(.formatted-editor, .source-editor)',
  'cm-s-obsidian': ':is(.formatted-editor, .source-editor)',
  'is-live-preview': '.formatted-editor',
  'markdown-preview-view': '.hibi-formatted',
  'markdown-rendered': '.hibi-formatted',
  'HyperMD-header': '.hibi-lp-heading',
  'cm-header': '.hibi-lp-heading',
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6].flatMap((level) => [
      [`HyperMD-header-${level}`, `.hibi-lp-h${level}`],
      [`cm-header-${level}`, `.hibi-lp-h${level}`],
    ]),
  ),
  'cm-strong': '.hibi-lp-strong',
  'cm-em': '.hibi-lp-em',
  'cm-strikethrough': '.hibi-lp-strike',
  'cm-link': '.hibi-lp-link',
  'cm-url': '.hibi-lp-link',
  'cm-hmd-internal-link': '.hibi-lp-link',
  'internal-link': '.hibi-lp-link',
  'external-link': '.hibi-lp-link',
  'cm-highlight': '.hibi-lp-highlight',
  'cm-inline-code': '.hibi-lp-code',
  'HyperMD-codeblock': '.hibi-lp-codeblock',
  'HyperMD-codeblock-begin': '.hibi-lp-codeblock-first',
  'HyperMD-codeblock-end': '.hibi-lp-codeblock-last',
  'HyperMD-quote': '.hibi-lp-quote',
  'cm-quote': '.hibi-lp-quote',
  'HyperMD-list-line': '.hibi-lp-list-item',
  'task-list-item': '.hibi-lp-task',
  callout: '.hibi-lp-alert',
  'callout-title': '.hibi-lp-alert-title',
  'callout-title-inner': '.hibi-lp-alert-title-text',
  tag: '.hibi-tag',
  'cm-hashtag': '.hibi-tag',
  'metadata-container': '.frontmatter',
  'metadata-properties': '.frontmatter-fields',
}

function aliasSelector(nodes: readonly Node[]): [Node[], number] {
  let count = 0
  const walk = (list: readonly Node[]): Node[] => {
    const out: Node[] = []
    for (let i = 0; i < list.length; i++) {
      const node = list[i] as Node
      const next = list[i + 1]
      if (isBlock(node)) {
        out.push({ ...node, children: walk(node.children) })
        continue
      }
      const alias =
        node.type === 'delim' &&
        node.value === '.' &&
        next?.type === 'ident' &&
        Object.hasOwn(SELECTOR_ALIASES, next.value)
          ? SELECTOR_ALIASES[next.value]
          : undefined
      if (alias === undefined) {
        out.push(node)
        continue
      }
      count++
      out.push({
        type: 'ident',
        raw: `:is(.${(next as Token).raw}, ${alias})`,
        value: '',
      })
      i++
    }
    return out
  }
  return [walk(nodes), count]
}

const bannedProperties = new Set([
  'behavior',
  '-ms-behavior',
  '-moz-binding',
  'binding',
])
const urlFunctions = new Set(['url', 'src', 'image-set', '-webkit-image-set'])
const safeData =
  /^data:(?:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)|font\/[\w.+-]+|application\/(?:x-)?font-[\w.+-]+|application\/vnd\.ms-fontobject)[;,]/i
const quoteUrl = (value: string) =>
  `url("${value.replace(/[\\"]|\p{Cc}/gu, (c) => `\\${c.charCodeAt(0).toString(16)} `)}")`

/** Normalize a theme-relative asset reference; null when it leaves the theme folder or isn't a plain path. */
export function assetPath(reference: string): string | null {
  const path = reference.replace(/[?#].*$/s, '')
  if (
    !path ||
    /^[a-z][\w+.-]*:/i.test(path) ||
    path.startsWith('/') ||
    path.includes('\\')
  )
    return null
  const parts: string[] = []
  for (const part of path.split('/')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(part)
    } catch {
      return null
    }
    if (decoded === '..' || decoded.includes('/') || decoded.includes('\\'))
      return null
    if (decoded && decoded !== '.') parts.push(decoded)
  }
  return parts.length ? parts.join('/') : null
}

type Context = {
  dropped: DroppedRule[]
  assets: string[]
  known: ReadonlyMap<string, string>
  aliased: number
}

// Replace each URL in a value with its checked form; returns the reason to drop otherwise.
function checkValue(nodes: Node[], context: Context): string | null {
  const resolve = (value: string): string | null | 'drop' => {
    const trimmed = value.trim()
    if (trimmed.startsWith('#') && !trimmed.includes(':'))
      return quoteUrl(trimmed)
    if (/^data:/i.test(trimmed))
      return safeData.test(trimmed) ? quoteUrl(trimmed) : 'drop'
    const path = assetPath(trimmed)
    if (path === null) return 'drop'
    if (!context.assets.includes(path)) context.assets.push(path)
    const data = context.known.get(path)
    return data ? quoteUrl(data) : null
  }
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as Node
    if (node.type === 'bad-url') return 'malformed url()'
    if (node.type === 'url') {
      const replacement = resolve(node.value)
      if (replacement === 'drop') return `blocked url ${brief(node.value)}`
      if (replacement === null)
        return `missing local asset ${brief(node.value)}`
      nodes[i] = { type: 'url', raw: replacement, value: node.value }
      continue
    }
    if (!isBlock(node)) continue
    const fn = node.open.type === 'function' ? node.open.value : ''
    if (fn === 'expression') return 'expression()'
    if (urlFunctions.has(fn)) {
      const strings = node.children.filter((child) => child.type === 'string')
      if (fn === 'url' || fn === 'src') {
        const only = strings[0]
        if (
          strings.length !== 1 ||
          node.children.some((child) => child !== only && !trivia(child))
        )
          return `unsupported ${fn}()`
        const replacement = resolve((only as Token).value)
        if (replacement === 'drop')
          return `blocked url ${brief((only as Token).value)}`
        if (replacement === null)
          return `missing local asset ${brief((only as Token).value)}`
        nodes[i] = { type: 'url', raw: replacement, value: '' }
        continue
      }
      // image-set() reads bare strings as URLs.
      for (let j = 0; j < node.children.length; j++) {
        const child = node.children[j] as Node
        if (child.type !== 'string') continue
        const replacement = resolve(child.value)
        if (replacement === 'drop') return `blocked url ${brief(child.value)}`
        if (replacement === null)
          return `missing local asset ${brief(child.value)}`
        node.children[j] = { type: 'url', raw: replacement, value: '' }
      }
    }
    const nested = checkValue(node.children, context)
    if (nested) return nested
  }
  return null
}

// A style rule body: declarations and nested rules.
function declarations(
  nodes: readonly Node[],
  context: Context,
  nested: boolean,
) {
  let out = ''
  let item: Node[] = []
  const flush = () => {
    const value = item
    item = []
    const text = serialize(value)
    const meaningful = value.filter((node) => !trivia(node))
    if (!meaningful.length) return
    const first = meaningful[0] as Token
    if (first.type !== 'ident' || meaningful[1]?.type !== ':') {
      context.dropped.push({ rule: brief(text), reason: 'not a declaration' })
      return
    }
    const property = first.value.toLowerCase()
    if (bannedProperties.has(property)) {
      context.dropped.push({
        rule: brief(text),
        reason: `${property} property`,
      })
      return
    }
    const reason = checkValue(value, context)
    if (reason) {
      context.dropped.push({ rule: brief(text), reason })
      return
    }
    out += `${serialize(value)};`
  }
  for (const node of nodes) {
    if (node.type === ';') flush()
    else if (isBlock(node, '{') && nested) {
      const prelude = item
      item = []
      out += rule(prelude, node, context, 'style')
    } else item.push(node)
  }
  flush()
  return out
}

const nestedAtRules = new Set([
  'media',
  'supports',
  'container',
  'layer',
  'starting-style',
  'scope',
])
const declarationAtRules = new Set(['font-face', 'page', 'counter-style'])
const keyframes = new Set(['keyframes', '-webkit-keyframes'])

function rule(
  prelude: Node[],
  body: Block | null,
  context: Context,
  kind: 'top' | 'style' | 'keyframes',
): string {
  const start = prelude.findIndex((node) => !trivia(node))
  const head = prelude[start]
  const text = () =>
    brief(serialize(prelude) + (body ? `{${serialize(body.children)}}` : ''))
  if (head?.type === 'at') {
    const name = head.value
    const rest = prelude.slice(start + 1)
    if (name === 'layer') {
      // Keep theme layers apart from Hibi's own.
      for (let i = 0; i < rest.length; i++) {
        const node = rest[i] as Node
        if (node.type === 'ident')
          rest[i] = { ...node, raw: `obsidian-${node.raw}` }
      }
      const kept = serialize([head, ...rest])
      if (!body) return `${kept};`
      return `${kept}{${list(body.children, context, kind === 'style')}}`
    }
    if (!body) {
      context.dropped.push({
        rule: text(),
        reason: name === 'import' ? '@import is not allowed' : `@${name}`,
      })
      return ''
    }
    if (nestedAtRules.has(name)) {
      if (checkValue(rest, context)) {
        context.dropped.push({ rule: text(), reason: `@${name} condition` })
        return ''
      }
      const inner =
        kind === 'style'
          ? declarations(body.children, context, true)
          : list(body.children, context, false)
      return `${serialize([head, ...rest])}{${inner}}`
    }
    if (declarationAtRules.has(name) && kind !== 'style')
      return `${serialize([head, ...rest])}{${declarations(body.children, context, false)}}`
    if (keyframes.has(name) && kind === 'top') {
      let inner = ''
      for (const [frame, block] of rules(body.children))
        inner += rule(frame, block, context, 'keyframes')
      return `${serialize([head, ...rest])}{${inner}}`
    }
    context.dropped.push({
      rule: text(),
      reason: name === 'import' ? '@import is not allowed' : `@${name}`,
    })
    return ''
  }
  if (!body) {
    context.dropped.push({ rule: text(), reason: 'incomplete rule' })
    return ''
  }
  if (kind === 'keyframes')
    return `${serialize(prelude)}{${declarations(body.children, context, false)}}`
  if (checkValue([...prelude], context)) {
    context.dropped.push({ rule: text(), reason: 'url in selector' })
    return ''
  }
  const [selector, count] = aliasSelector(prelude)
  context.aliased += count
  return `${serialize(selector)}{${declarations(body.children, context, true)}}`
}

// Split a rule list into [prelude, block]; at-rules without a block end at ';'.
function rules(nodes: readonly Node[]): [Node[], Block | null][] {
  const found: [Node[], Block | null][] = []
  let prelude: Node[] = []
  for (const node of nodes) {
    if (isBlock(node, '{')) {
      found.push([prelude, node])
      prelude = []
    } else if (
      node.type === ';' &&
      prelude.find((item) => !trivia(item))?.type === 'at'
    ) {
      found.push([prelude, null])
      prelude = []
    } else if (
      prelude.length ||
      (!trivia(node) && node.type !== 'cdo' && node.type !== 'cdc')
    )
      prelude.push(node)
  }
  if (prelude.some((node) => !trivia(node))) found.push([prelude, null])
  return found
}

function list(
  nodes: readonly Node[],
  context: Context,
  nested: boolean,
): string {
  if (nested) return declarations(nodes, context, true)
  return rules(nodes)
    .map(([prelude, body]) => rule(prelude, body, context, 'top'))
    .join('')
}

/** Check untrusted Obsidian CSS. Dropped rules are reported, never silently lost. */
export function sanitizeCss(
  input: string,
  options: SanitizeOptions = {},
): SanitizeResult {
  const maxBytes = options.maxBytes ?? MAX_THEME_BYTES
  const size = new TextEncoder().encode(input).length
  if (size > maxBytes)
    return {
      css: '',
      dropped: [
        {
          rule: '(whole file)',
          reason: `larger than ${Math.round(maxBytes / 1024)} KiB`,
        },
      ],
      assets: [],
      aliased: 0,
    }
  const context: Context = {
    dropped: [],
    assets: [],
    known: options.assets ?? new Map(),
    aliased: 0,
  }
  const css = list(tree(tokenize(input)), context, false)
  return {
    css,
    dropped: context.dropped,
    assets: context.assets,
    aliased: context.aliased,
  }
}
