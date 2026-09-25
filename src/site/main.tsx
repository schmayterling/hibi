import DOMPurify from 'dompurify'
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Network,
  Palette,
  PanelLeft,
  Search,
} from 'lucide-react'
import { marked } from 'marked'
import MiniSearch from 'minisearch'
import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import type { Root } from 'react-dom/client'
import { GraphCanvas } from '../addons/graph/Canvas'
import {
  CommandPalette,
  type PaletteCommand,
} from '../renderer/src/CommandPalette'
import '../addons/graph/style.css'
import { ColorschemeSettings } from '../ui/ColorschemeSettings'
import { IconButton, TextInput } from '../ui/Controls'
import { createColorschemeStore } from '../ui/colorschemes'
import { DialogProvider, useDialogs } from '../ui/DialogProvider'
import { ShortcutKeys } from '../ui/ShortcutKeys'
import { Sidebar, type SidebarItem } from '../ui/Sidebar'
import { useSidebarResize } from '../ui/useSidebarResize'
import { homePage, pageRoute, type SiteData } from './data'
import './site.css'

export function startSite(workspace: SiteData, root: Root) {
  const options = workspace.options
  const colorschemes = createColorschemeStore(
    `hibi-site-colorscheme:${options.url || workspace.name}`,
    options.theme,
    !options.lockTheme && !options.passwordProtected,
  )
  colorschemes.start()
  document.documentElement.lang = options.language
  if (
    !document.getElementById('site-overrides') &&
    (workspace.css || options.css)
  ) {
    const styles = document.createElement('style')
    styles.id = 'site-overrides'
    styles.textContent = `${workspace.css ?? ''}\n${options.css}`
    document.head.append(styles)
  }
  const pages = workspace.pages.map((page) => {
    const heading = marked
      .lexer(page.markdown)
      .find((token) => token.type === 'heading')
    return {
      ...page,
      id: page.path,
      title:
        page.title ||
        (heading?.type === 'heading'
          ? heading.text.replace(/[*`]/g, '')
          : (page.path
              .split('/')
              .at(-1)
              ?.replace(/\.[^./]+$/, '') ?? page.path)),
    }
  })
  const home = homePage(pages)
  const byPath = new Map(pages.map((page) => [page.path, page]))
  const index = new MiniSearch({
    fields: ['title', 'path', 'markdown'],
    storeFields: ['path', 'title'],
    searchOptions: {
      prefix: true,
      fuzzy: 0.2,
      boost: { title: 4, path: 2 },
      combineWith: 'AND',
    },
  })
  index.addAll(pages)
  const navigation: SidebarItem[] = []
  for (const page of pages) {
    const parts = page.path.split('/')
    let siblings = navigation
    for (let depth = 0; depth < parts.length; depth++) {
      const name = parts[depth] ?? ''
      const path = parts.slice(0, depth + 1).join('/')
      if (depth === parts.length - 1)
        siblings.push({ id: path, label: page.title, icon: FileText })
      else {
        let folder = siblings.find((item) => item.id === path)
        if (!folder) {
          const overview =
            byPath.get(`${path}/README.md`) ?? byPath.get(`${path}/index.md`)
          folder = {
            id: path,
            label: overview?.title ?? name,
            icon: Folder,
            children: [],
          }
          siblings.push(folder)
        }
        siblings = folder.children ?? []
      }
    }
  }

  const siteRoot = new URL(
    document.querySelector('meta[name="hibi-root"]')?.getAttribute('content') ??
      './',
    location.href,
  )
  function route(url = new URL(location.href)) {
    const params = new URLSearchParams(url.hash.slice(1))
    if (workspace.routing === 'paths' && !params.has('page')) {
      let path = url.pathname
        .slice(siteRoot.pathname.length)
        .replace(/(?:index\.html)?$/, '')
        .replace(/\/$/, '')
      let anchor = url.hash.slice(1)
      try {
        path = decodeURIComponent(path)
        anchor = decodeURIComponent(anchor)
      } catch {
        /* Unknown paths show the missing-page view. */
      }
      return {
        path: path || home?.path || '',
        anchor,
      }
    }
    return {
      path: params.get('page') ?? home?.path ?? '',
      anchor: params.get('anchor') ?? '',
    }
  }
  function destination(path: string, anchor = '') {
    if (workspace.routing === 'paths')
      return new URL(
        `${path === home?.path ? '' : pageRoute(path)}${location.protocol === 'file:' ? 'index.html' : ''}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`,
        siteRoot,
      ).href
    return `#${new URLSearchParams({ page: path, ...(anchor ? { anchor } : {}) })}`
  }
  function navigate(path: string, anchor = '') {
    if (workspace.routing === 'paths') {
      try {
        history.pushState(null, '', destination(path, anchor))
        window.dispatchEvent(new PopStateEvent('popstate'))
      } catch {
        location.href = destination(path, anchor)
      }
      return
    }
    location.hash = destination(path, anchor)
  }

  function renderMarkdown(path: string, markdown: string, html?: string) {
    const fragment = DOMPurify.sanitize(
      html ?? marked.parse(markdown, { async: false }),
      html === undefined
        ? {
            RETURN_DOM_FRAGMENT: true,
            ALLOWED_TAGS: [
              'h1',
              'h2',
              'h3',
              'h4',
              'h5',
              'h6',
              'p',
              'strong',
              'em',
              'del',
              's',
              'blockquote',
              'pre',
              'code',
              'ul',
              'ol',
              'li',
              'a',
              'img',
              'table',
              'thead',
              'tbody',
              'tr',
              'th',
              'td',
              'hr',
              'br',
              'details',
              'summary',
              'input',
            ],
            ALLOWED_ATTR: [
              'href',
              'title',
              'src',
              'alt',
              'colspan',
              'rowspan',
              'align',
              'checked',
              'disabled',
              'type',
            ],
          }
        : {
            RETURN_DOM_FRAGMENT: true,
            USE_PROFILES: { html: true, mathMl: true, svg: true },
            FORBID_TAGS: [
              'style',
              'form',
              'button',
              'textarea',
              'select',
              'iframe',
              'object',
              'embed',
              'audio',
              'video',
            ],
            FORBID_ATTR: ['name'],
          },
    )
    for (const element of fragment.querySelectorAll('[id]')) {
      const id = element.id
      if (
        (element.matches('a[data-footnote-ref]') &&
          /^fnref-[\w%.~-]+$/.test(id)) ||
        (element.matches('li') && /^fn-[\w%.~-]+$/.test(id)) ||
        (element.matches('h2.sr-only') && id === 'footnote-label')
      )
        continue
      element.removeAttribute('id')
    }
    const slugs = new Map<string, number>()
    const outline: { id: string; label: string; depth: number }[] = []
    for (const heading of fragment.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      if (heading.id === 'footnote-label') continue
      const slug = (heading.textContent ?? '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .trim()
        .replace(/\s+/g, '-')
      const count = slugs.get(slug) ?? 0
      slugs.set(slug, count + 1)
      heading.id = `doc-${slug}${count ? `-${count}` : ''}`
      if (heading.tagName !== 'H1' && heading.textContent?.trim())
        outline.push({
          id: heading.id,
          label: heading.textContent.trim(),
          depth: Number(heading.tagName.slice(1)),
        })
    }
    for (const table of fragment.querySelectorAll('table')) {
      const scroll = document.createElement('div')
      scroll.className = 'site-table-scroll'
      scroll.tabIndex = 0
      scroll.setAttribute('role', 'region')
      scroll.setAttribute('aria-label', 'table')
      table.replaceWith(scroll)
      scroll.append(table)
    }
    for (const input of fragment.querySelectorAll('input'))
      input.disabled = true
    for (const image of fragment.querySelectorAll('img')) {
      const embedded =
        byPath.get(path)?.images?.[image.getAttribute('src') ?? '']
      if (
        typeof embedded === 'string' &&
        /^data:video\/(mp4|webm|ogg);base64,/i.test(embedded)
      ) {
        const video = document.createElement('video')
        video.controls = true
        video.preload = 'metadata'
        video.setAttribute('aria-label', image.alt || 'Video attachment')
        video.src = embedded
        image.replaceWith(video)
        continue
      }
      if (typeof embedded === 'string') image.setAttribute('src', embedded)
      if (
        !/^data:image\/(png|jpeg|gif|webp|avif|svg\+xml);base64,/i.test(
          image.getAttribute('src') ?? '',
        )
      )
        image.removeAttribute('src')
    }
    for (const link of fragment.querySelectorAll('a')) {
      const href = link.getAttribute('href')
      if (!href) continue
      try {
        const url = new URL(href, `https://hibi.invalid/${path}`)
        if (url.origin !== 'https://hibi.invalid') {
          if (!['https:', 'http:', 'mailto:'].includes(url.protocol))
            link.removeAttribute('href')
          else {
            link.target = '_blank'
            link.rel = 'noopener noreferrer'
          }
          continue
        }
        const relative = decodeURIComponent(url.pathname.slice(1))
        const target = [
          relative,
          `${relative.replace(/\/$/, '')}/README.md`,
          `${relative.replace(/\/$/, '')}/index.md`,
        ].find((candidate) => byPath.has(candidate))
        if (target)
          link.href = destination(target, decodeURIComponent(url.hash.slice(1)))
        else {
          link.removeAttribute('href')
          link.removeAttribute('title')
          link.dataset.tooltip = 'This file is not included in the export.'
        }
      } catch {
        link.removeAttribute('href')
      }
    }
    const container = document.createElement('div')
    container.append(fragment)
    return { html: container.innerHTML, outline }
  }

  function DocumentationSite() {
    const dialogs = useDialogs()
    const [current, setCurrent] = useState(() => route())
    const [palette, setPalette] = useState(false)
    const [sidebar, setSidebar] = useState(() => innerWidth > 700)
    const [mobile, setMobile] = useState(() => innerWidth <= 700)
    const [activeHeading, setActiveHeading] = useState('')
    const sidebarResize = useSidebarResize(256)
    const page = byPath.get(current.path)
    const { html, outline } = useMemo(
      () =>
        page
          ? renderMarkdown(page.path, page.markdown, page.html)
          : { html: '', outline: [] },
      [page],
    )
    useEffect(() => {
      const media = matchMedia('(max-width: 700px)')
      const resized = () => {
        setMobile(media.matches)
        if (media.matches) setSidebar(false)
      }
      media.addEventListener('change', resized)
      const update = () => {
        setCurrent(route())
        if (media.matches) setSidebar(false)
      }
      const keyboard = (event: KeyboardEvent) => {
        if (dialogs.isOpen()) return
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === 'k'
        ) {
          event.preventDefault()
          setPalette(true)
        }
        if (
          event.key === 'Escape' &&
          !document.querySelector('dialog[open]') &&
          media.matches
        )
          setSidebar(false)
      }
      window.addEventListener('hashchange', update)
      window.addEventListener('popstate', update)
      window.addEventListener('keydown', keyboard)
      return () => {
        window.removeEventListener('hashchange', update)
        window.removeEventListener('popstate', update)
        window.removeEventListener('keydown', keyboard)
        media.removeEventListener('change', resized)
      }
    }, [dialogs])
    useEffect(() => {
      document.title = `${page?.title ?? 'Page not found'} · ${workspace.name}`
      const meta = (name: string, value: string, property = false) => {
        const attr = property ? 'property' : 'name'
        let node = document.head.querySelector<HTMLMetaElement>(
          `meta[${attr}="${name}"]`,
        )
        if (!node) {
          node = document.createElement('meta')
          node.setAttribute(attr, name)
          document.head.append(node)
        }
        node.content = value
      }
      meta('description', page?.description || options.description)
      meta('og:title', document.title, true)
      meta('og:description', page?.description || options.description, true)
      meta('twitter:title', document.title)
      meta('twitter:description', page?.description || options.description)
      if (options.favicon) {
        let icon =
          document.head.querySelector<HTMLLinkElement>('link[rel="icon"]')
        if (!icon) {
          icon = document.createElement('link')
          icon.rel = 'icon'
          document.head.append(icon)
        }
        icon.href = options.favicon
      }
      if (options.url && workspace.routing === 'paths') {
        const canonical = new URL(
          page?.path === home?.path ? './' : pageRoute(current.path),
          options.url,
        ).href
        let link = document.head.querySelector<HTMLLinkElement>(
          'link[rel="canonical"]',
        )
        if (!link) {
          link = document.createElement('link')
          link.rel = 'canonical'
          document.head.append(link)
        }
        link.href = canonical
        meta('og:url', canonical, true)
        const structured = document.head.querySelector(
          'script[type="application/ld+json"]',
        )
        if (structured)
          structured.textContent = JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebPage',
            name: document.title,
            description: page?.description || options.description,
            url: canonical,
            isPartOf: {
              '@type': 'WebSite',
              name: workspace.name,
              url: options.url,
            },
          })
      }
      if (current.anchor)
        (
          document.getElementById(`doc-${current.anchor}`) ??
          document.getElementById(current.anchor)
        )?.scrollIntoView()
      else document.querySelector('.site-content')?.scrollTo(0, 0)
    }, [page, current.path, current.anchor])
    useEffect(() => {
      const scroller = document.querySelector('.site-content')
      const headings = outline
        .map(({ id }) => document.getElementById(id))
        .filter((node): node is HTMLElement => Boolean(node))
      let frame = 0
      const update = () => {
        frame = 0
        const edge = (scroller?.getBoundingClientRect().top ?? 0) + 48
        let active = headings[0]?.id ?? ''
        for (const heading of headings) {
          if (heading.getBoundingClientRect().top > edge) break
          active = heading.id
        }
        setActiveHeading(active)
      }
      const scroll = () => {
        if (!frame) frame = requestAnimationFrame(update)
      }
      update()
      scroller?.addEventListener('scroll', scroll, { passive: true })
      return () => {
        scroller?.removeEventListener('scroll', scroll)
        cancelAnimationFrame(frame)
      }
    }, [outline])
    const pageIndex = pages.findIndex((entry) => entry.path === current.path)
    const previous = pages[pageIndex - 1]
    const next = pageIndex >= 0 ? pages[pageIndex + 1] : undefined
    const folders = current.path.split('/').slice(0, -1)
    const outlineLinks = (
      <nav aria-label="On this page">
        {outline.map((heading) => (
          <a
            key={heading.id}
            href={destination(current.path, heading.id.slice(4))}
            aria-current={activeHeading === heading.id ? 'location' : undefined}
            style={
              {
                '--heading-indent': `${Math.max(0, heading.depth - 2) * 12}px`,
              } as CSSProperties
            }
            onClick={(event) => {
              const details = event.currentTarget.closest('details')
              if (details) details.open = false
              document.getElementById(heading.id)?.scrollIntoView()
            }}
          >
            {heading.label}
          </a>
        ))}
      </nav>
    )
    const command = (path: string): PaletteCommand => ({
      id: path,
      label: byPath.get(path)?.title ?? path,
      category: 'documents',
      run: () => {
        navigate(path)
        if (innerWidth <= 700) setSidebar(false)
      },
    })
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: delegates native anchor clicks, including keyboard activation, to history navigation.
      // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation of native anchors already emits click.
      <div
        className="documentation-site"
        data-sidebar={sidebar}
        style={
          { '--sidebar-width': `${sidebarResize.width}px` } as CSSProperties
        }
        onClick={(event) => {
          if (
            workspace.routing !== 'paths' ||
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return
          const link =
            event.target instanceof Element ? event.target.closest('a') : null
          if (!link || link.target || !link.href.startsWith(siteRoot.href))
            return
          const next = route(new URL(link.href))
          if (!byPath.has(next.path)) return
          event.preventDefault()
          navigate(next.path, next.anchor)
        }}
      >
        <header className="site-header">
          <div className="site-navigation-controls">
            <IconButton
              type="button"
              aria-label="Toggle navigation"
              aria-expanded={sidebar}
              onClick={() => setSidebar(!sidebar)}
            >
              <PanelLeft size={18} />
            </IconButton>
          </div>
          <div className="site-header-content">
            <nav
              className="site-breadcrumbs"
              aria-label="Breadcrumbs"
              aria-hidden={mobile && sidebar}
            >
              <ol>
                <li>
                  <a href={destination(home?.path ?? '')}>
                    {options.logo ? (
                      <img className="site-logo" src={options.logo} alt="" />
                    ) : (
                      <Folder aria-hidden="true" />
                    )}
                    <span>{workspace.name}</span>
                  </a>
                </li>
                {folders.map((folder, index) => {
                  const prefix = folders.slice(0, index + 1).join('/')
                  const target =
                    [`${prefix}/README.md`, `${prefix}/index.md`].find((path) =>
                      byPath.has(path),
                    ) ??
                    pages.find((entry) => entry.path.startsWith(`${prefix}/`))
                      ?.path
                  return (
                    <li key={prefix}>
                      <ChevronRight aria-hidden="true" />
                      {target ? (
                        <a href={destination(target)}>{folder}</a>
                      ) : (
                        <span>{folder}</span>
                      )}
                    </li>
                  )
                })}
                <li aria-current="page">
                  <ChevronRight aria-hidden="true" />
                  <span>{page?.title ?? 'Page not found'}</span>
                </li>
              </ol>
            </nav>
            <button
              type="button"
              className="site-search"
              onClick={() => setPalette(true)}
              aria-label="Search documentation"
            >
              <Search size={15} />
              <span className="site-search-label">Search documentation</span>
              <ShortcutKeys
                shortcut={/Mac/.test(navigator.platform) ? 'meta+k' : 'ctrl+k'}
                platform={/Mac/.test(navigator.platform) ? 'darwin' : 'linux'}
              />
            </button>
            {workspace.graph && (
              <IconButton
                aria-label="Open graph"
                onClick={() => {
                  const dialog = dialogs.open({
                    title: 'Graph',
                    size: 'wide',
                    content: () => (
                      <SiteGraph
                        active={current.path}
                        open={(path) => {
                          dialog.close()
                          navigate(path)
                        }}
                      />
                    ),
                  })
                }}
              >
                <Network size={18} aria-hidden />
              </IconButton>
            )}
            {!options.lockTheme && (
              <IconButton
                aria-label="Color scheme"
                title="Color scheme"
                onClick={() =>
                  dialogs.open({
                    title: 'Appearance',
                    content: () => <ColorschemeSettings store={colorschemes} />,
                  })
                }
              >
                <Palette aria-hidden="true" />
              </IconButton>
            )}
          </div>
        </header>
        <div className="site-layout">
          <button
            type="button"
            className="site-nav-scrim"
            aria-label="Close navigation"
            aria-hidden={!mobile || !sidebar}
            tabIndex={mobile && sidebar ? 0 : -1}
            onClick={() => setSidebar(false)}
          />
          <Sidebar
            resize={{ ...sidebarResize, onCollapse: () => setSidebar(false) }}
            open={sidebar}
            items={navigation}
            selected={current.path}
            onSelect={(path) => {
              navigate(path)
              if (innerWidth <= 700) setSidebar(false)
            }}
            label="Documentation navigation"
          />
          <main
            className="site-content"
            aria-label="Documentation"
            inert={mobile && sidebar}
          >
            {page ? (
              <div className="site-document-layout">
                <div className="site-reading">
                  {outline.length > 0 && (
                    <details className="site-outline-mobile">
                      <summary>
                        On this page
                        <ChevronDown size={14} aria-hidden="true" />
                      </summary>
                      {outlineLinks}
                    </details>
                  )}
                  <article
                    className="tiptap"
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: strict DOMPurify allowlist sanitizes this markdown before rendering.
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                  {(previous || next) && (
                    <nav
                      className="site-pagination"
                      aria-label="Page navigation"
                    >
                      {previous ? (
                        <a href={destination(previous.path)}>
                          <span>
                            <ArrowLeft size={14} aria-hidden="true" />
                            Previous
                          </span>
                          <strong>{previous.title}</strong>
                        </a>
                      ) : (
                        <span />
                      )}
                      {next ? (
                        <a className="site-next" href={destination(next.path)}>
                          <span>
                            Next
                            <ArrowRight size={14} aria-hidden="true" />
                          </span>
                          <strong>{next.title}</strong>
                        </a>
                      ) : (
                        <span />
                      )}
                    </nav>
                  )}
                </div>
                {outline.length > 0 && (
                  <aside className="site-outline">
                    <p>On this page</p>
                    {outlineLinks}
                  </aside>
                )}
              </div>
            ) : (
              <div className="site-missing">
                <h1>Page not found</h1>
                <button type="button" onClick={() => setPalette(true)}>
                  Search documentation
                </button>
              </div>
            )}
          </main>
        </div>
        {palette && (
          <CommandPalette
            commands={pages.map((page) => command(page.path))}
            platform={/Mac/.test(navigator.platform) ? 'darwin' : 'linux'}
            searchCommands={(query) =>
              query.trim()
                ? index
                    .search(query)
                    .slice(0, 50)
                    .map((result) => command(String(result.id)))
                : pages.slice(0, 50).map((page) => command(page.path))
            }
            onClose={() => setPalette(false)}
          />
        )}
      </div>
    )
  }

  function SiteGraph({
    active,
    open,
  }: {
    active: string
    open: (path: string) => void
  }) {
    const [query, setQuery] = useState('')
    const graph = useMemo(() => {
      const nodes =
        workspace.graph?.nodes
          .filter((node) => node.id.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 500) ?? []
      const ids = new Set(nodes.map((node) => node.id))
      return {
        nodes,
        edges:
          workspace.graph?.edges.filter(
            (edge) => ids.has(edge.source) && ids.has(edge.target),
          ) ?? [],
      }
    }, [query])
    return (
      <div className="site-graph">
        <TextInput
          type="search"
          aria-label="Filter graph notes"
          placeholder="Filter notes…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <GraphCanvas
          graph={graph}
          active={active}
          open={open}
          resetKey={query}
        />
      </div>
    )
  }
  if (
    workspace.routing === 'paths' &&
    new URLSearchParams(location.hash.slice(1)).has('page')
  ) {
    const legacy = route()
    if (byPath.has(legacy.path)) {
      try {
        history.replaceState(null, '', destination(legacy.path, legacy.anchor))
      } catch {
        /* File viewers can still use the original fragment link. */
      }
    }
  }
  root.render(
    <DialogProvider>
      <DocumentationSite />
    </DialogProvider>,
  )
}
