export const UI_CASE_CHANNEL = 'app:ui-case'
export type UiCase = 'sentence' | 'lowercase'

/** UI copy only; never apply to filenames, editor content, or field values. */
export function sentenceCase(value: string) {
  // A message can start with a file name of any type, such as notes.txt.
  if (/^\s*(?:https?:|[/.~]|\S+\.[\p{L}\p{N}]+\b)/iu.test(value)) return value
  // Acronyms in extensions and path or host parts, as in index.html, keep their case.
  return value
    .replace(
      /^(\s*)(\p{Ll})/u,
      (_match, space: string, letter: string) =>
        space + letter.toLocaleUpperCase(),
    )
    .replace(
      /(?<![./\\])\b(?:wpm|cpm|ui|api|url|pdf|yaml|html|css|json)\b(?!\.\w)/gi,
      (word) => word.toUpperCase(),
    )
}
