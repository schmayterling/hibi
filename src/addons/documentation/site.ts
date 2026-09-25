import { createCipheriv, pbkdf2, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { decodeHTML } from 'entities'
import { marked } from 'marked'
import sanitizeHtml from 'sanitize-html'
import { parseDocument } from 'yaml'
import { bundledColorschemes } from '../../shared/color-palettes.ts'
import { COLOR_TOKENS } from '../../shared/colorschemes.ts'
import { readFrontmatter } from '../../shared/frontmatter.ts'
import type { WorkspaceSnapshot } from '../../shared/workspace'
import {
  homePage,
  type LockedSite,
  localPage,
  pageRoute,
  type SiteData,
  type SitePage,
  siteJson,
} from '../../site/data.ts'
import { noteGraph } from '../graph/model.ts'
import { type ExportOptions, exportOptions } from './options.ts'

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
const plain = (value: string) =>
  decodeHTML(
    sanitizeHtml(marked.parseInline(value, { async: false }), {
      allowedTags: [],
      allowedAttributes: {},
    }),
  )
    .replace(/\s+/g, ' ')
    .trim()
const alertAttributes = ({
  'data-alert': type,
  'data-fold': fold,
  ...attrs
}: Record<string, string>) => ({
  ...attrs,
  ...(/(?:^|\s)github-alert(?:\s|$)/.test(attrs.class ?? '') &&
  /^[a-z][a-z0-9-]{0,39}$/.test(type ?? '')
    ? {
        'data-alert': type,
        ...(fold === '' || fold === '+' || fold === '-'
          ? { 'data-fold': fold }
          : {}),
      }
    : {}),
})
const renderedHtml = (html: string) =>
  sanitizeHtml(html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'img',
      'details',
      'summary',
      'input',
      'del',
      's',
      'svg',
      'g',
      'path',
      'rect',
      'circle',
      'line',
      'polyline',
      'polygon',
      'text',
      'tspan',
      'math',
      'semantics',
      'mrow',
      'mi',
      'mn',
      'mo',
      'mfrac',
      'msup',
      'msub',
      'msubsup',
      'msqrt',
      'mroot',
      'mtext',
      'annotation',
    ],
    allowedAttributes: {
      '*': ['class', 'style', 'title', 'role', 'aria-*'],
      a: ['href', 'rel', 'id', 'data-footnote-ref', 'data-footnote-backref'],
      blockquote: ['data-alert', 'data-fold'],
      h2: ['id'],
      li: ['id'],
      section: ['data-footnotes'],
      img: ['src', 'alt', 'width', 'height'],
      input: ['type', 'checked', 'disabled'],
      svg: ['viewBox', 'width', 'height'],
      path: ['d', 'fill', 'stroke', 'stroke-width', 'transform'],
      math: ['display'],
      annotation: ['encoding'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['data'] },
    allowProtocolRelative: false,
    transformTags: {
      blockquote: (_tag, attrs) => ({
        tagName: 'blockquote',
        attribs: alertAttributes(attrs),
      }),
      a: (
        _tag,
        {
          id,
          'data-footnote-ref': ref,
          'data-footnote-backref': backref,
          ...attrs
        },
      ) => ({
        tagName: 'a',
        attribs: {
          ...attrs,
          ...(ref !== undefined && /^fnref-[\w%.~-]+$/.test(id ?? '')
            ? { id, 'data-footnote-ref': '' }
            : {}),
          ...(backref !== undefined ? { 'data-footnote-backref': '' } : {}),
        },
      }),
      h2: (_tag, { id, ...attrs }) => ({
        tagName: 'h2',
        attribs: {
          ...attrs,
          ...(attrs.class === 'sr-only' && id === 'footnote-label'
            ? { id }
            : {}),
        },
      }),
      li: (_tag, { id, ...attrs }) => ({
        tagName: 'li',
        attribs: {
          ...attrs,
          ...(/^fn-[\w%.~-]+$/.test(id ?? '') ? { id } : {}),
        },
      }),
    },
  })

export function prepareSite(
  snapshot: WorkspaceSnapshot,
  options: ExportOptions,
): SiteData {
  options = exportOptions(options)
  const seen = new Set<string>()
  const pages = snapshot.pages.map((page) => {
    if (
      !page.path ||
      page.path.startsWith('/') ||
      /[\\\0:]/.test(page.path) ||
      page.path
        .split('/')
        .some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('The workspace contains an invalid export path.')
    if (
      !options.singleFile &&
      page.path
        .split('/')
        .some(
          (part) =>
            /[<>"|?*]|[. ]$/.test(part) ||
            [...part].some((char) => char.charCodeAt(0) < 32) ||
            /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part),
        )
    )
      throw new Error(
        'Rename files with names that cannot be used in a static export.',
      )
    if (!options.singleFile && seen.has(page.path.toLowerCase()))
      throw new Error(
        'Rename files whose paths differ only in letter case before exporting.',
      )
    seen.add(page.path.toLowerCase())
    const frontmatter = readFrontmatter(page.markdown)
    const document = frontmatter ? parseDocument(frontmatter.yaml) : null
    const property = (key: string) => {
      const value: unknown = document?.get(key)
      return typeof value === 'string' ? value.trim() : ''
    }
    const source = frontmatter?.content ?? page.markdown
    const tokens = marked.lexer(source)
    const images: Record<string, string> = Object.create(null)
    marked.walkTokens(tokens, (token) => {
      if (token.type !== 'image') return
      const data = page.images?.[token.href]
      if (
        typeof data === 'string' &&
        /^data:(?:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)|video\/(?:mp4|webm|ogg));base64,[a-z\d+/]+={0,2}$/i.test(
          data,
        )
      )
        images[token.href] = data
    })
    const heading = tokens.find((token) => token.type === 'heading')
    const paragraph = tokens.find((token) => token.type === 'paragraph')
    const title =
      property('title') ||
      (heading?.type === 'heading' ? plain(heading.text) : '') ||
      page.path
        .split('/')
        .at(-1)
        ?.replace(/\.[^.]+$/, '') ||
      page.path
    const description =
      property('description') ||
      (options.autoSeo && paragraph?.type === 'paragraph'
        ? plain(paragraph.text).slice(0, 160)
        : '') ||
      options.description
    return {
      path: page.path,
      markdown: page.markdown,
      title: title.slice(0, 200),
      description: description.slice(0, 500),
      html: renderedHtml(page.html ?? marked.parse(source, { async: false })),
      ...(Object.keys(images).length ? { images } : {}),
    }
  })
  return {
    name: options.title || snapshot.name,
    pages,
    options,
    appearance: options.theme,
    routing: options.singleFile ? 'hash' : 'paths',
    ...(typeof snapshot.css === 'string' ? { css: snapshot.css } : {}),
    ...(options.graph ? { graph: noteGraph(pages) } : {}),
  }
}

function content(site: SiteData, page: SitePage, prefix: string) {
  const paths = new Set(site.pages.map((page) => page.path))
  let html = sanitizeHtml(page.html ?? '', {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'img',
      'details',
      'summary',
      'input',
      'del',
      's',
    ],
    allowedAttributes: {
      '*': ['class'],
      a: [
        'href',
        'title',
        'rel',
        'id',
        'data-footnote-ref',
        'data-footnote-backref',
        'aria-describedby',
        'aria-label',
      ],
      blockquote: ['data-alert', 'data-fold'],
      h2: ['id'],
      li: ['id'],
      section: ['data-footnotes', 'role'],
      img: ['src', 'alt', 'title'],
      input: ['type', 'checked', 'disabled'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'data'],
    transformTags: {
      blockquote: (_tag, attrs) => ({
        tagName: 'blockquote',
        attribs: alertAttributes(attrs),
      }),
      a: (_tag, attrs) => {
        const target = localPage(page.path, attrs.href ?? '', paths)
        const href = target
          ? site.routing === 'hash'
            ? `#${new URLSearchParams({ page: target.path, ...(target.anchor ? { anchor: target.anchor } : {}) })}`
            : `${prefix}${pageRoute(target.path)}${target.anchor ? `#${encodeURIComponent(target.anchor)}` : ''}`
          : /^(?:https?:|mailto:)/i.test(attrs.href ?? '')
            ? attrs.href
            : undefined
        return {
          tagName: 'a',
          attribs: {
            ...(href ? { href } : {}),
            rel: 'noopener noreferrer',
            ...(attrs['data-footnote-ref'] !== undefined &&
            /^fnref-[\w%.~-]+$/.test(attrs.id ?? '')
              ? {
                  id: attrs.id,
                  'data-footnote-ref': '',
                  'aria-describedby': 'footnote-label',
                }
              : {}),
            ...(attrs['data-footnote-backref'] !== undefined
              ? {
                  'data-footnote-backref': '',
                  'aria-label': attrs['aria-label'] ?? 'Back to reference',
                }
              : {}),
          },
        }
      },
      h2: (_tag, attrs) => ({
        tagName: 'h2',
        attribs: {
          ...(attrs.class ? { class: attrs.class } : {}),
          ...(attrs.class === 'sr-only' && attrs.id === 'footnote-label'
            ? { id: 'footnote-label' }
            : {}),
        },
      }),
      li: (_tag, attrs) => ({
        tagName: 'li',
        attribs: {
          ...(attrs.class ? { class: attrs.class } : {}),
          ...(/^fn-[\w%.~-]+$/.test(attrs.id ?? '') ? { id: attrs.id } : {}),
        },
      }),
      section: (_tag, attrs) => ({
        tagName: 'section',
        attribs: {
          ...(attrs.class ? { class: attrs.class } : {}),
          ...(attrs['data-footnotes'] === undefined
            ? {}
            : { 'data-footnotes': '', role: 'doc-endnotes' }),
        },
      }),
      img: (_tag, attrs) => {
        const src = page.images?.[attrs.src ?? '']
        return {
          tagName: 'img',
          attribs: {
            alt: attrs.alt ?? '',
            ...(src?.startsWith('data:image/') ? { src } : {}),
          },
        }
      },
      input: (_tag, attrs) => ({
        tagName: 'input',
        attribs: {
          type: 'checkbox',
          disabled: '',
          ...(attrs.checked === undefined ? {} : { checked: '' }),
        },
      }),
    },
  })
  const slugs = new Map<string, number>()
  html = html.replace(
    /<(h[1-6])([^>]*)>([\s\S]*?)<\/\1>/g,
    (_match, tag: string, attrs: string, body: string) => {
      if (/\sid="[^"]+"/.test(attrs)) return `<${tag}${attrs}>${body}</${tag}>`
      const slug = plain(body)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .trim()
        .replace(/\s+/g, '-')
      const count = slugs.get(slug) ?? 0
      slugs.set(slug, count + 1)
      return `<${tag}${attrs} id="${escapeHtml(slug)}${count ? `-${count}` : ''}">${body}</${tag}>`
    },
  )
  const home = homePage(site.pages)
  const index = site.pages.indexOf(page)
  const navigation =
    page === home
      ? site.pages
      : [home, site.pages[index - 1], site.pages[index + 1]].filter(
          (entry): entry is SitePage => !!entry,
        )
  return `<div class="documentation-site"><header class="site-header">${escapeHtml(site.name)}</header><div class="site-layout"><main class="site-content"><div class="site-document-layout"><article class="tiptap">${html}</article><nav aria-label="Pages">${[...new Set(navigation)].map((entry) => `<a href="${escapeHtml(site.routing === 'hash' ? `#${new URLSearchParams({ page: entry.path })}` : `${prefix}${pageRoute(entry.path)}`)}">${escapeHtml(entry.title)}</a>`).join(' ')}</nav></div></main></div></div>`
}

function themeCss(site: SiteData) {
  const rules = (mode: 'light' | 'dark') => {
    const scheme =
      bundledColorschemes.find(
        (scheme) =>
          scheme.id === site.options.theme[mode] && scheme.appearance === mode,
      ) ?? bundledColorschemes.find((scheme) => scheme.id === `hibi-${mode}`)!
    return `:root{color-scheme:${mode};${COLOR_TOKENS.map((key) => `--${key}:${scheme.colors[key]}`).join(';')}}`
  }
  return site.options.theme.mode === 'system'
    ? `${rules('light')}@media(prefers-color-scheme:dark){${rules('dark')}}`
    : rules(site.options.theme.mode)
}

export function siteHead(
  site: SiteData,
  page: SitePage | undefined,
  canonical: string,
  locked = false,
) {
  const title = locked
    ? 'Protected site'
    : page
      ? `${page.title} · ${site.name}`
      : site.name
  const description = locked
    ? ''
    : page?.description || site.options.description
  const meta = (name: string, value: string, property = false) =>
    value
      ? `<meta ${property ? 'property' : 'name'}="${name}" content="${escapeHtml(value)}">`
      : ''
  const structured =
    !locked && site.options.autoSeo && canonical
      ? `<script type="application/ld+json">${siteJson({ '@context': 'https://schema.org', '@type': 'WebPage', name: title, description, url: canonical, isPartOf: { '@type': 'WebSite', name: site.name, url: site.options.url } })}</script>`
      : ''
  return `<title>${escapeHtml(title)}</title>${meta('description', description)}${meta('author', locked ? '' : site.options.author)}${meta('robots', locked || !site.options.indexing ? 'noindex, nofollow' : 'index, follow')}${meta('og:title', title, true)}${meta('og:description', description, true)}${meta('og:type', 'website', true)}${meta('og:site_name', locked ? '' : site.name, true)}${meta('og:url', locked ? '' : canonical, true)}${meta('og:image', locked ? '' : site.options.socialImage, true)}${meta('twitter:card', site.options.socialImage && !locked ? 'summary_large_image' : 'summary')}${meta('twitter:title', title)}${meta('twitter:description', description)}${meta('twitter:image', locked ? '' : site.options.socialImage)}${canonical && !locked ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ''}${site.options.favicon && !locked ? `<link rel="icon" href="${escapeHtml(site.options.favicon)}">` : ''}${structured}`
}

async function encrypt(site: SiteData, password: string): Promise<LockedSite> {
  if (password.length < 8 || password.length > 1024)
    throw new Error('Use a password between 8 and 1,024 characters.')
  const salt = randomBytes(16),
    iv = randomBytes(12),
    iterations = 600_000
  const key = await promisify(pbkdf2)(password, salt, iterations, 32, 'sha256')
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(site), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  return {
    encrypted: true,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    iterations,
  }
}

/** Builds files in memory; callers choose and validate the destination. */
export async function siteFiles(
  template: string,
  site: SiteData,
  password = '',
) {
  const locked = !!password
  if (site.options.passwordProtected && !locked)
    throw new Error('Enter the password for this export.')
  if (locked)
    site = {
      ...site,
      routing: 'hash',
      options: { ...site.options, passwordProtected: true },
    }
  const data = locked ? await encrypt(site, password) : site
  const home = homePage(site.pages) as SitePage | undefined
  let assets = 'hibi-assets'
  while (
    site.pages.some((page) => page.path.toLowerCase().split('/')[0] === assets)
  )
    assets += '-site'
  const customCss = `@layer hibi-theme {${themeCss(site)}}\n${site.css ?? ''}\n${site.options.css}`
  const safeStyle = (css: string) => css.replace(/<\/style/gi, '<\\/style')
  const decorate = (
    html: string,
    page: SitePage | undefined,
    prefix: string,
    canonical: string,
  ) =>
    html
      .replace(
        '<html lang="en">',
        `<html lang="${escapeHtml(locked ? 'en' : site.options.language)}">`,
      )
      .replace(/<title>[^<]*<\/title>/, () =>
        siteHead(site, page, canonical, locked),
      )
      .replace(
        '</head>',
        () =>
          `<meta name="hibi-root" content="${prefix}">${locked ? '' : site.options.singleFile ? `<style id="site-overrides">${safeStyle(customCss)}</style>` : `<link id="site-overrides" rel="stylesheet" href="${prefix}${assets}/custom.css">`}</head>`,
      )
      .replace(
        '<div id="root"></div>',
        () =>
          `<div id="root">${locked ? '<main class="site-unlock"><h1>Protected site</h1><noscript>Enable JavaScript to unlock this site.</noscript></main>' : page ? content(site, page, prefix) : ''}</div>`,
      )
  const files = new Map<string, string>()
  if (site.options.singleFile) {
    files.set(
      'index.html',
      decorate(
        template.replace('__HIBI_WORKSPACE_DATA__', () => siteJson(data)),
        home,
        './',
        site.options.url,
      ),
    )
    return files
  }
  const scripts = [...template.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .join('\n')
  const css = [...template.matchAll(/<style>([\s\S]*?)<\/style>/g)]
    .map((match) => match[1])
    .join('\n')
  files.set(`${assets}/site.js`, scripts)
  files.set(`${assets}/site.css`, css)
  if (!locked) files.set(`${assets}/custom.css`, customCss)
  files.set(
    `${assets}/workspace.js`,
    `window.__HIBI_WORKSPACE__=${siteJson(data)};`,
  )
  const shell = (prefix: string) =>
    template
      .replace(
        /<style>[\s\S]*?<\/style>/g,
        () => `<link rel="stylesheet" href="${prefix}${assets}/site.css">`,
      )
      .replace(
        /<script id="workspace-data" type="application\/json">[\s\S]*?<\/script>/,
        () => `<script src="${prefix}${assets}/workspace.js"></script>`,
      )
      .replace(
        /<script>[\s\S]*?<\/script>/g,
        () => `<script src="${prefix}${assets}/site.js" defer></script>`,
      )
      .replace(/script-src 'sha256-[^']+'/, "script-src 'self'")
      .replace("style-src 'unsafe-inline'", "style-src 'self' 'unsafe-inline'")
  files.set('index.html', decorate(shell('./'), home, './', site.options.url))
  const urls: string[] = site.options.url && !locked ? [site.options.url] : []
  if (!locked)
    for (const page of site.pages) {
      const prefix = '../'.repeat(page.path.split('/').length)
      const canonical = site.options.url
        ? new URL(page === home ? './' : pageRoute(page.path), site.options.url)
            .href
        : ''
      files.set(
        `${page.path}/index.html`,
        decorate(shell(prefix), page, prefix, canonical),
      )
      if (canonical && page !== home) urls.push(canonical)
    }
  files.set(
    'robots.txt',
    locked || !site.options.indexing
      ? 'User-agent: *\nDisallow: /\n'
      : `User-agent: *\nAllow: /\n${site.options.url ? `Sitemap: ${new URL('sitemap.xml', site.options.url).href}\n` : ''}`,
  )
  if (!locked && site.options.indexing && urls.length)
    files.set(
      'sitemap.xml',
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${escapeHtml(url)}</loc></url>`).join('')}</urlset>`,
    )
  return files
}
