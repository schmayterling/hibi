import type { ExportOptions } from '../addons/documentation/options'
import type { noteGraph } from '../addons/graph/model'
import type { WorkspacePage, WorkspaceSnapshot } from '../shared/workspace'

export type SitePage = WorkspacePage & { title: string; description: string }
export type SiteData = Omit<WorkspaceSnapshot, 'pages'> & {
  pages: SitePage[]
  options: ExportOptions
  routing: 'hash' | 'paths'
  graph?: ReturnType<typeof noteGraph>
}
export type LockedSite = {
  encrypted: true
  salt: string
  iv: string
  ciphertext: string
  iterations: number
}
export const siteJson = (value: unknown) =>
  JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
export const pageRoute = (path: string) =>
  path.split('/').map(encodeURIComponent).join('/') + '/'
export const homePage = (pages: readonly WorkspacePage[]) =>
  pages.find((page) => /^(readme|index)\.md$/i.test(page.path)) ?? pages[0]

export const isMermaidImage = (src: string, className: string) =>
  className.split(/\s+/).includes('mermaid-diagram') &&
  /^data:image\/svg\+xml,%3Csvg(?:%20|%09|%0A|%0D|%3E)/i.test(src)

export function localPage(
  from: string,
  href: string,
  paths: ReadonlySet<string>,
) {
  try {
    const url = new URL(href, `https://hibi.invalid/${from}`)
    if (url.origin !== 'https://hibi.invalid') return null
    const relative = decodeURIComponent(url.pathname.slice(1))
    const path = [
      relative,
      `${relative.replace(/\/$/, '')}/README.md`,
      `${relative.replace(/\/$/, '')}/index.md`,
    ].find((path) => paths.has(path))
    return path ? { path, anchor: decodeURIComponent(url.hash.slice(1)) } : null
  } catch {
    return null
  }
}
