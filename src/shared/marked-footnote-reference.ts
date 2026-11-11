import type { Lexer, Token } from 'marked'

type Label = { next: Map<string, Label>; end?: boolean }
const definitions = new WeakMap<Lexer, Label>()
const scopes = new WeakMap<() => Iterator<string>, Label>()
const runs = new WeakMap<Token[], { remaining: number; matches: Set<number> }>()

/**
 * GFM's footnote label match: collapsed whitespace, then full case folding
 * (`ß`, `ẞ` and `SS` match, as do `σ`, `ς` and `Σ`). Lowercased last, as the
 * footnote dependency keys its labels, so ASCII keys read as before.
 */
export const footnoteLabel = (label: string) =>
  label
    .replace(/[\t\n\r ]+/g, ' ')
    .trim()
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()

function addLabel(node: Label, label: string) {
  const key = footnoteLabel(label)
  for (let at = key.length - 1; at >= 0; at--) {
    const character = key.charAt(at)
    let next: Label | undefined = node.next.get(character)
    if (!next) {
      next = { next: new Map() }
      node.next.set(character, next)
    }
    node = next
  }
  node.end = true
}

/** Remember definitions before Marked drains the document's inline queue. */
export function rememberFootnote(lexer: Lexer, label: string) {
  let root = definitions.get(lexer)
  if (!root) {
    root = { next: new Map() }
    definitions.set(lexer, root)
  }
  addLabel(root, label)
}

/**
 * A reference recognized by the dependency, without retrying its greedy label
 * regex at every nested opener. Each ]/whitespace-delimited span is read once;
 * a reversed definition trie recognizes all of its reference suffixes together.
 */
export function footnoteReference(
  lexer: Lexer,
  source: string,
  tokens: Token[],
) {
  if (!source.startsWith('[^')) return
  const root = definitions.get(lexer)
  let scoped: Label | undefined
  const labels = (lexer.tokens.links as unknown as Iterable<string>)[
    Symbol.iterator
  ]
  if (labels) {
    scoped = scopes.get(labels)
    if (!scoped) {
      // Source owners expose one index identity per definition update. Build it
      // once across regions; obtaining the iterator tracks negative references.
      scoped = { next: new Map() }
      for (const key of { [Symbol.iterator]: labels })
        if (key.startsWith('\u0000footnote:')) addLabel(scoped, key.slice(10))
      scopes.set(labels, scoped)
    }
  }
  if (!root?.next.size && !scoped?.next.size) return
  let run = runs.get(tokens)
  if (!run || source.length <= run.remaining) {
    let end = 2
    while (end < source.length) {
      if (source.charCodeAt(end) === 93 || /\s/.test(source.charAt(end))) break
      end++
    }
    run = { remaining: source.length - end, matches: new Set() }
    runs.set(tokens, run)
    if (source.charCodeAt(end) === 93) {
      const lower = footnoteLabel(source.slice(2, end))
      let at = end,
        folded = lower.length,
        node: Label | undefined = root,
        scopedNode = scoped
      while (at > 2 && (node || scopedNode)) {
        const code = source.charCodeAt(at - 1)
        const width =
          code >= 0xdc00 &&
          code <= 0xdfff &&
          source.charCodeAt(at - 2) >= 0xd800 &&
          source.charCodeAt(at - 2) <= 0xdbff
            ? 2
            : 1
        // Per-codepoint lengths map expansions (such as ß to SS or İ) back to
        // physical source offsets; folding erases contextual sigma.
        const length = footnoteLabel(source.slice(at - width, at)).length
        at -= width
        for (let i = 0; i < length && (node || scopedNode); i++) {
          const character = lower.charAt(--folded)
          node = node?.next.get(character)
          scopedNode = scopedNode?.next.get(character)
        }
        if ((node?.end || scopedNode?.end) && source.slice(at - 2, at) === '[^')
          run.matches.add(source.length - at + 2)
      }
    }
  }
  if (!run.matches.has(source.length)) return
  const end = source.length - run.remaining
  return { raw: source.slice(0, end + 1), label: source.slice(2, end) }
}
