import DOMPurify from 'dompurify'
import { ArrowLeft, FileText } from 'lucide-react'
import { Marked } from 'marked'
import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '../../shared/errors'
import { Button, Panel, PanelMessage } from '../../ui/Controls'
import { DocumentNotice } from '../../ui/DocumentNotice'
import './addon-readme.css'

const markdown = new Marked({ gfm: true })
const external = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i
const imageData = /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)[;,]/i
const localPath = (base: string, href: string) =>
  base.slice(0, base.lastIndexOf('/') + 1) +
  decodeURIComponent(href.split(/[?#]/)[0]!)

export default function AddonReadme({ id }: { id: string }) {
  const [history, setHistory] = useState(['README.md'])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const host = useRef<HTMLDivElement>(null)
  const pendingAnchor = useRef<string | null>(null)
  const path = history.at(-1)!
  useEffect(() => {
    const path = history.at(-1)!
    let active = true
    setLoading(true)
    setError('')
    void (async () => {
      const document = await window.hibi.getAddonDocumentation(id, path)
      const fragment = DOMPurify.sanitize(
        document.kind === 'markdown'
          ? markdown.parse(document.content, { async: false })
          : '<img alt="Image">',
        {
          RETURN_DOM_FRAGMENT: true,
          ALLOW_DATA_ATTR: false,
          ALLOW_ARIA_ATTR: false,
          ALLOWED_TAGS: [
            'p',
            'a',
            'h1',
            'h2',
            'h3',
            'h4',
            'h5',
            'h6',
            'ul',
            'ol',
            'li',
            'pre',
            'code',
            'strong',
            'em',
            'del',
            'blockquote',
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
            'kbd',
            'sup',
            'sub',
            'input',
          ],
          ALLOWED_ATTR: [
            'href',
            'src',
            'alt',
            'title',
            'colspan',
            'rowspan',
            'start',
            'open',
            'type',
            'checked',
            'disabled',
          ],
        },
      )
      for (const input of fragment.querySelectorAll('input')) {
        if (input.type === 'checkbox') input.disabled = true
        else input.remove()
      }
      const headings = new Map<string, number>()
      for (const heading of fragment.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
        const slug = (heading.textContent ?? '')
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, '-')
          .replace(/^-|-$/g, '')
        const count = headings.get(slug) ?? 0
        headings.set(slug, count + 1)
        heading.id = `readme-${slug}${count ? `-${count}` : ''}`
      }
      let embedded = 0
      const images = [...fragment.querySelectorAll('img')]
      for (const [index, image] of images.entries()) {
        const source =
          document.kind === 'image'
            ? document.content
            : (image.getAttribute('src') ?? '')
        image.removeAttribute('src')
        if (!active) return
        if (index >= 32 || embedded > 20 * 1024 * 1024) {
          image.remove()
          continue
        }
        if (/^https?:\/\//i.test(source) || source.startsWith('//')) {
          if (image.closest('a')) {
            image.replaceWith(
              window.document.createTextNode(image.alt || 'View image'),
            )
            continue
          }
          const link = window.document.createElement('a')
          link.href = source.startsWith('//') ? `https:${source}` : source
          link.textContent = image.alt || 'View image'
          image.replaceWith(link)
          continue
        }
        const resource = imageData.test(source)
          ? source
          : !external.test(source)
            ? await Promise.resolve()
                .then(() =>
                  window.hibi.getAddonDocumentation(
                    id,
                    localPath(path, source),
                  ),
                )
                .then((value) =>
                  value.kind === 'image' ? value.content : null,
                )
                .catch(() => null)
            : null
        if (
          resource &&
          imageData.test(resource) &&
          embedded + resource.length <= 20 * 1024 * 1024
        ) {
          embedded += resource.length
          image.src = resource
        } else image.replaceWith(window.document.createTextNode(image.alt))
      }
      if (active) {
        host.current?.replaceChildren(fragment)
        setLoading(false)
      }
    })().catch((error: unknown) => {
      if (active) {
        setError(errorMessage(error))
        setLoading(false)
      }
    })
    return () => {
      active = false
    }
  }, [id, history])

  useEffect(() => {
    if (loading || !pendingAnchor.current) return
    host.current
      ?.querySelector(`#readme-${CSS.escape(pendingAnchor.current)}`)
      ?.scrollIntoView({ block: 'start' })
    pendingAnchor.current = null
  }, [loading])

  const follow = useCallback(
    async (event: MouseEvent) => {
      const link = (event.target as Element).closest('a[href]')
      if (!link) return
      event.preventDefault()
      const href = link.getAttribute('href')!
      try {
        if (href.startsWith('#')) {
          host.current
            ?.querySelector(
              `#readme-${CSS.escape(decodeURIComponent(href.slice(1)))}`,
            )
            ?.scrollIntoView({ block: 'start' })
        } else if (href.startsWith('https://docs.hibi.garden/')) {
          const url = new URL(href)
          const params = new URLSearchParams(url.hash.slice(1))
          const document =
            url.pathname === '/'
              ? await window.hibi
                  .getAddonDocumentation(
                    id,
                    `../../../docs/${params.get('page') || 'README.md'}`,
                  )
                  .catch(() => null)
              : null
          if (document) {
            pendingAnchor.current = params.get('anchor')
            setHistory((items) => [...items, document.path])
          } else await window.hibi.openAddonDocumentationLink(href)
        } else if (external.test(href)) {
          await window.hibi.openAddonDocumentationLink(
            href.startsWith('//') ? `https:${href}` : href,
          )
        } else setHistory((items) => [...items, localPath(path, href)])
      } catch (error) {
        setError(errorMessage(error))
      }
    },
    [id, path],
  )
  useEffect(() => {
    const element = host.current
    if (!element) return
    const activate = (event: MouseEvent) => {
      void follow(event)
    }
    element.addEventListener('click', activate)
    element.addEventListener('auxclick', activate)
    return () => {
      element.removeEventListener('click', activate)
      element.removeEventListener('auxclick', activate)
    }
  }, [follow])
  return (
    <div className="addon-readme-view">
      {history.length > 1 && (
        <Button
          className="readme-back"
          onClick={() => setHistory((items) => items.slice(0, -1))}
        >
          <ArrowLeft size={16} />
          Back
        </Button>
      )}
      {loading && (
        <Panel>
          <PanelMessage
            icon={<FileText size={28} />}
            title="Loading readme…"
            loading
          />
        </Panel>
      )}
      {error && <DocumentNotice title="Readme unavailable" message={error} />}
      {/* Read-only markdown uses sanitized nodes; links are handled without navigating the app. */}
      <div
        ref={host}
        className="addon-readme"
        data-verbatim="true"
        hidden={loading || !!error}
      />
    </div>
  )
}
