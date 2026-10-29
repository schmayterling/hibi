import type { MarkdownParagraphRule } from '../api'
import { blockMath, inlineMath } from './grammar.ts'

export const mathParagraphRule: MarkdownParagraphRule = {
  characters: '$',
  escape(source, { literals, parentType }) {
    const marker = [...literals].find(([, value]) => value === '$')?.[0]
    if (!marker || !source.includes(marker)) return source
    // Added escapes can expose another match; each pass consumes a marker.
    const limit = source.split(marker).length - 1
    for (let pass = 0; pass < limit; pass++) {
      const dollars = new Set<number>()
      const restored = source.replaceAll(marker, (_, index) => {
        dollars.add(index - dollars.size * (marker.length - 1))
        return '$'
      })
      const escaped = new Set<number>()
      let lineStart = 0
      for (let index = 0; index < restored.length; index++) {
        if (restored[index] === '\n') lineStart = index + 1
        if (restored[index] !== '$') continue
        const block =
          parentType !== 'table' &&
          index - lineStart <= 3 &&
          /^ *$/.test(restored.slice(lineStart, index))
            ? blockMath(restored.slice(index))
            : undefined
        const token = block ?? inlineMath(restored.slice(index))
        if (token)
          for (let at = index; at < index + token.raw.length; at++)
            if (dollars.has(at)) escaped.add(at)
        // A literal dollar beside an equation delimiter can prevent its parsing.
        if (
          dollars.has(index) &&
          ((restored[index - 1] === '$' && !dollars.has(index - 1)) ||
            (restored[index + 1] === '$' && !dollars.has(index + 1)))
        )
          escaped.add(index)
      }
      if (!escaped.size) break
      let occurrence = 0
      source = source.replaceAll(marker, (_, index) =>
        escaped.has(index - occurrence++ * (marker.length - 1))
          ? '\\$'
          : marker,
      )
    }
    return source
  },
}
