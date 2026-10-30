import { decodeHTMLStrict } from 'entities'

export function decodeMarkdownEntities(text: string) {
  return text.replace(
    /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]+);/g,
    (entity) => decodeHTMLStrict(entity),
  )
}
