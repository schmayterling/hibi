import { marked } from 'marked'
import type { WorkspacePage } from '../shared/workspace'

export function pageTitle(page: WorkspacePage & { title?: string }) {
  if (page.title) return page.title
  const heading = marked
    .lexer(page.markdown)
    .find((token) => token.type === 'heading')
  return heading?.type === 'heading'
    ? heading.text.replace(/[*`]/g, '')
    : (page.path
        .split('/')
        .at(-1)
        ?.replace(/\.[^./]+$/, '') ?? page.path)
}
