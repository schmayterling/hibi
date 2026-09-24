import {
  type AnyExtension,
  getExtensionField,
  type MarkdownTokenizer,
} from '@tiptap/core'
import { Table, TableKit } from '@tiptap/extension-table'

const native = getExtensionField<MarkdownTokenizer>(Table, 'markdownTokenizer')

function firstTwoLines(source: string) {
  const first = source.indexOf('\n')
  if (first < 0) return source
  const second = source.indexOf('\n', first + 1)
  return second < 0 ? source : source.slice(0, second)
}

/** Native table detection only inspects two lines, never the remaining document. */
export function guardNativeTableTokenizer(extension: AnyExtension) {
  const tokenizer = getExtensionField<MarkdownTokenizer | undefined>(
    extension,
    'markdownTokenizer',
  )
  const start = native.start
  if (tokenizer !== native || typeof start !== 'function') return extension
  const tokenize = native.tokenize
  return extension.extend({
    markdownTokenizer: {
      ...native,
      start: (source: string) => start(firstTwoLines(source)),
      tokenize(...args: Parameters<MarkdownTokenizer['tokenize']>) {
        const prefix = firstTwoLines(args[0]),
          newline = prefix.indexOf('\n')
        // Tokenization requires the same delimiter as start(), but does not
        // require a pipe in the header. Supply one only for that check.
        if (newline < 0 || start(`|${prefix.slice(newline)}`) !== 0)
          return undefined
        return tokenize(...args)
      },
    },
  })
}

export const NativeTableKit = TableKit.extend({
  addExtensions() {
    return this.parent?.().map(guardNativeTableTokenizer) ?? []
  },
})
