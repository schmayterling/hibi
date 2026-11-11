import type { Token } from 'marked'

// Each inline run owns its token array, including nested labels/emphasis.
const wikiEnds = new WeakMap<Token[], number>()
const highlightEnds = new WeakMap<Token[], number>()

export function wikiToken(source: string, embed: boolean, tokens: Token[]) {
  const prefix = embed ? '![[' : '[['
  if (!source.startsWith(prefix)) return
  // Suffix lengths keep the same terminator valid as this inline run advances.
  let remaining = wikiEnds.get(tokens)
  if (remaining === undefined || source.length <= remaining) {
    let end = prefix.length
    while (end < source.length) {
      const code = source.charCodeAt(end)
      if (code === 93 || code === 13 || code === 10) break
      end++
    }
    remaining = source.length - end
    wikiEnds.set(tokens, remaining)
  }
  const end = source.length - remaining
  if (end <= prefix.length || source.slice(end, end + 2) !== ']]') return
  const [target, alias] = source.slice(prefix.length, end).split('|', 2)
  if (!target?.trim()) return
  const label = alias?.trim() || target.trim()
  return {
    type: embed ? 'obsidianEmbed' : 'obsidianWikiLink',
    raw: source.slice(0, end + 2),
    text: label,
    target: target.trim(),
    tokens: [{ type: 'text', raw: label, text: label }],
  }
}

export function highlightToken(source: string, tokens: Token[]) {
  if (!source.startsWith('==') || !/\S/.test(source.charAt(2))) return
  // Cache the next nonspace-preceded == or line end for this inline run.
  let remaining = highlightEnds.get(tokens)
  if (remaining === undefined || source.length - remaining < 4) {
    let end = 3
    while (end < source.length) {
      const code = source.charCodeAt(end)
      if (code === 13 || code === 10) break
      if (
        end > 3 &&
        code === 61 &&
        source.charCodeAt(end + 1) === 61 &&
        /\S/.test(source.charAt(end - 1))
      )
        break
      end++
    }
    remaining = source.length - end
    highlightEnds.set(tokens, remaining)
  }
  let end = source.length - remaining
  // The regex prefers a multi-character capture before its single-char fallback.
  if (source.slice(end, end + 2) !== '==') {
    if (source.slice(3, 5) !== '==') return
    end = 3
  }
  const text = source.slice(2, end)
  return {
    type: 'obsidianHighlight',
    raw: source.slice(0, end + 2),
    text,
    tokens: [{ type: 'text', raw: text, text }],
  }
}
