const SVG = 'http://www.w3.org/2000/svg'
const XLINK = 'http://www.w3.org/1999/xlink'
const XML = 'http://www.w3.org/XML/1998/namespace'
// Drawing elements only: nothing that runs, embeds documents, animates
// attributes such as href, or loads a filter image.
const elements = new Set(
  `svg g defs symbol use path rect circle ellipse line polyline polygon text
  tspan textPath title desc style image linearGradient radialGradient stop
  pattern clipPath mask marker filter feBlend feColorMatrix feComponentTransfer
  feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap
  feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR
  feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight
  feSpecularLighting feSpotLight feTile feTurbulence`.split(/\s+/),
)
// CSS functions that compute values; anything else (image-set, src, …) could load.
const functions = new Set(
  `url rgb rgba hsl hsla hwb lab lch oklab oklch color calc min max clamp var
  matrix translate translatex translatey scale scalex scaley rotate skew skewx
  skewy drop-shadow blur brightness contrast grayscale hue-rotate invert
  opacity saturate sepia cubic-bezier steps`.split(/\s+/),
)
const raster = /^data:image\/(?:png|jpeg);base64,[a-z\d+/=\s]*$/i
const name = /[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/y
const space = /\s*/y

const malformed = () =>
  new Error('This SVG is not valid XML. Choose another image.')
const refusedStyle = () =>
  new Error(
    "This SVG's styles use @ rules or CSS functions Hibi doesn't accept, such as image-set() or circle(). Choose a self-contained image.",
  )
const refused = () =>
  new Error(
    "This SVG uses content Hibi doesn't accept, such as scripts, links to other files or unknown elements. Choose a self-contained image.",
  )

function entities(value: string) {
  return value.replace(
    /&(?:#x([\da-f]+)|#(\d+)|(amp|lt|gt|quot|apos));|&/gi,
    (_, hex, decimal, named) => {
      if (named)
        return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[
          named.toLowerCase() as 'amp'
        ] as string
      const code = hex ? Number.parseInt(hex, 16) : Number(decimal)
      // A bare '&' has no code either.
      if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        throw malformed()
      return String.fromCodePoint(code)
    },
  )
}

/**
 * Refuses CSS that could load something: at-rules and unknown functions.
 * Comments are checked like the rest: stripping them would need a string-aware
 * tokenizer, and a comment with '@' or 'name(' in it is only a false refusal.
 */
function checkCss(value: string, stylesheet: boolean) {
  const css = value.replace(
    /\\([\da-f]{1,6})\s?|\\([\s\S])/gi,
    (_, hex, char) => {
      if (!hex) return char
      const code = Number.parseInt(hex, 16)
      return code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '\ufffd'
    },
  )
  if (stylesheet && css.includes('@')) throw refusedStyle()
  // Each match takes a whole run of name characters, so a long run without
  // '(' is read once; matching just names before '(' rescans it per start.
  for (const [run] of css.matchAll(/[\w-]+\(?/g))
    if (run.endsWith('(') && !functions.has(run.slice(0, -1).toLowerCase()))
      throw refusedStyle()
  for (const [, target] of css.matchAll(/url\(\s*["']?\s*([^"')\s]*)/gi))
    if (!target?.startsWith('#')) throw refused()
}

/**
 * Accepts only well-formed UTF-8 SVG drawings: SVG elements, fragment links,
 * PNG or JPEG data images, and CSS without at-rules or loading functions.
 */
export function checkSvgIcon(bytes: Uint8Array) {
  let text: string
  // UTF-16 and other encodings fail as UTF-8.
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Save the SVG as UTF-8 and choose it again.')
  }
  const declaration = /^<\?xml\s[^?]*\?>/.exec(text)
  if (declaration && /encoding\s*=\s*["'](?!utf-8["'])/i.test(declaration[0]))
    throw new Error('Save the SVG as UTF-8 and choose it again.')
  let at = declaration?.[0].length ?? 0
  const stack: { tag: string; namespaces: Map<string, string>; css: string }[] =
    []
  let root = false
  // Each declaration copies the scope; a cap keeps that copying linear.
  let declarations = 0
  const read = (pattern: RegExp) => {
    pattern.lastIndex = at
    const match = pattern.exec(text)
    if (!match) return null
    at = pattern.lastIndex
    return match[0]
  }
  while (at < text.length) {
    const top = stack.at(-1)
    if (text.startsWith('<!--', at)) {
      const end = text.indexOf('-->', at + 4)
      if (end < 0) throw malformed()
      at = end + 3
    } else if (text.startsWith('<![CDATA[', at)) {
      const end = text.indexOf(']]>', at)
      if (end < 0 || !top) throw malformed()
      top.css += text.slice(at + 9, end)
      at = end + 3
    } else if (text.startsWith('<!', at) || text.startsWith('<?', at)) {
      // Doctypes declare entities; processing instructions load stylesheets.
      throw refused()
    } else if (text.startsWith('</', at)) {
      at += 2
      const tag = read(name)
      read(space)
      if (!top || tag !== top.tag || text[at] !== '>') throw malformed()
      at++
      stack.pop()
      if (top.tag.replace(/^.*:/, '') === 'style') checkCss(top.css, true)
    } else if (text[at] === '<') {
      if (root && !stack.length) throw malformed()
      at++
      const tag = read(name)
      if (!tag) throw malformed()
      const attributes = new Map<string, string>()
      for (;;) {
        const gap = read(space)
        if (text.startsWith('/>', at) || text[at] === '>') break
        const key = gap ? read(name) : null
        if (!key || attributes.has(key)) throw malformed()
        read(space)
        if (text[at] !== '=') throw malformed()
        at++
        read(space)
        const quote = text[at]
        const end = text.indexOf(quote ?? '', at + 1)
        if ((quote !== '"' && quote !== "'") || end < 0) throw malformed()
        const raw = text.slice(at + 1, end)
        if (raw.includes('<')) throw malformed()
        attributes.set(key, entities(raw))
        at = end + 1
      }
      const declared = [...attributes].filter(
        ([key]) => key === 'xmlns' || key.startsWith('xmlns:'),
      )
      declarations += declared.length
      if (declarations > 32) throw refused()
      const namespaces = declared.length
        ? new Map(top?.namespaces)
        : (top?.namespaces ?? new Map<string, string>())
      for (const [key, value] of declared)
        namespaces.set(key === 'xmlns' ? '' : key.slice(6), value)
      const [prefix, local] = tag.includes(':') ? tag.split(':') : ['', tag]
      if (!root && local !== 'svg')
        throw new Error('This file is not an SVG image.')
      if (
        namespaces.get(prefix as string) !== SVG ||
        !elements.has(local as string)
      )
        throw refused()
      for (const [key, value] of attributes) {
        if (key === 'xmlns' || key.startsWith('xmlns:')) continue
        const [space, attribute] = key.includes(':')
          ? key.split(':')
          : [null, key]
        // Prefixed attributes: xlink ones, and only xml:space and xml:lang.
        if (space != null) {
          const owner = space === 'xml' ? XML : namespaces.get(space)
          if (
            owner === XML
              ? attribute !== 'space' && attribute !== 'lang'
              : owner !== XLINK
          )
            throw refused()
        }
        if (/^on/i.test(attribute as string) || attribute === 'src')
          throw refused()
        if (attribute === 'href') {
          if (!(local === 'image' ? raster.test(value) : value.startsWith('#')))
            throw refused()
        } else checkCss(value, attribute === 'style')
      }
      root = true
      if (text.startsWith('/>', at)) at += 2
      else {
        at++
        stack.push({ tag, namespaces, css: '' })
      }
    } else {
      const end = text.indexOf('<', at)
      const content = entities(text.slice(at, end < 0 ? undefined : end))
      if (!top && content.trim()) throw malformed()
      if (top) top.css += content
      at = end < 0 ? text.length : end
    }
  }
  if (!root || stack.length) throw malformed()
}
