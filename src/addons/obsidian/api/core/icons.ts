import { icons } from 'lucide-react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const custom = new Map<string, SVGSVGElement[]>()
const aliases: Record<string, string> = {
  gear: 'settings',
  'cross-in-box': 'square-x',
  document: 'file-text',
}

export function addIcon(id: string, svgContent: string) {
  const parsed = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${svgContent}</svg>`,
    'image/svg+xml',
  )
  const svg = parsed.documentElement
  if (svg.tagName !== 'svg' || parsed.querySelector('parsererror'))
    throw new Error('Invalid plugin icon SVG.')
  // Icons are markup, never code or remote resources.
  const allowed = new Set([
    'svg',
    'g',
    'path',
    'circle',
    'ellipse',
    'rect',
    'line',
    'polyline',
    'polygon',
    'title',
    'desc',
  ])
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    if (!allowed.has(element.localName))
      throw new Error('Unsupported plugin icon SVG element.')
    for (const attr of [...element.attributes])
      if (
        /^on/i.test(attr.name) ||
        /href|style/i.test(attr.name) ||
        /url\s*\(|javascript:/i.test(attr.value)
      )
        throw new Error('Plugin icons cannot load resources or run code.')
  }
  const icon = svg as unknown as SVGSVGElement
  const entries = custom.get(id) ?? []
  entries.push(icon)
  custom.set(id, entries)
  return () => {
    const remaining = (custom.get(id) ?? []).filter((value) => value !== icon)
    if (remaining.length) custom.set(id, remaining)
    else custom.delete(id)
  }
}

export function getIcon(id: string): SVGSVGElement | null {
  const registered = custom.get(id)?.at(-1)
  if (registered) return document.importNode(registered, true)
  const normalized = aliases[id] ?? id.replace(/^lucide-/, '')
  const name = normalized.replace(
    /(^|-)([a-z])/g,
    (_match, _hyphen: string, letter: string) => letter.toUpperCase(),
  )
  const Icon = icons[name as keyof typeof icons]
  if (!Icon) return null
  const markup = renderToStaticMarkup(
    createElement(Icon, { size: 24, 'aria-hidden': true }),
  )
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml')
  return document.importNode(
    parsed.documentElement,
    true,
  ) as unknown as SVGSVGElement
}

export function setIcon(element: HTMLElement, id: string) {
  const icon = getIcon(id)
  element.replaceChildren(...(icon ? [icon] : []))
}
