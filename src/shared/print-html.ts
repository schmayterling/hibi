/** Countries whose printers default to US Letter; everywhere else prints A4. */
const letterCountries = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE'])

export const printPageSize = (country: string) =>
  letterCountries.has(country.toUpperCase()) ? 'Letter' : 'A4'

/** No scripts, network, frames or forms; only inline styles and data images and fonts. */
export const PRINT_CSP =
  "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

// Comes after the export renderer's own CSS so print layout wins.
const printCss = `html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:var(--background);color:var(--ink);font:11pt/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:break-word}
h1,h2,h3,h4,h5,h6{margin:1.3em 0 .5em;line-height:1.25;break-after:avoid;page-break-after:avoid}
h1{font-size:1.9em}h2{font-size:1.5em}h3{font-size:1.25em}h4,h5,h6{font-size:1em}
body>:first-child{margin-top:0}
p,ul,ol,dl,blockquote,table,pre,figure{margin:0 0 .9em}
a{color:var(--syntax-link)}
img,svg{max-width:100%;height:auto}
code,kbd,samp{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
:not(pre)>code{padding:.1em .3em;border-radius:4px;background:var(--code-background);color:var(--code-ink)}
pre{padding:10px 12px;border-radius:6px;background:var(--code-background);color:var(--code-ink);white-space:pre-wrap;overflow-wrap:anywhere}
pre code{font-size:.88em}
blockquote{padding:0 0 0 1em;border-left:3px solid var(--border);color:var(--muted)}
hr{border:0;border-top:1px solid var(--border);margin:1.5em 0}
table{border-collapse:collapse;max-width:100%}
thead{display:table-header-group}
th,td{padding:4px 8px;border:1px solid var(--border);text-align:left;vertical-align:top}
th{background:var(--surface)}
li>input[type=checkbox]{margin:0 .4em 0 0;vertical-align:middle}
li:has(>input[type=checkbox]){list-style:none}
.katex-display,.tiptap-mathematics-render[data-type=block-math]{overflow:visible}
pre,tr,img,svg,figure,blockquote,.katex-display,.github-alert{break-inside:avoid;page-break-inside:avoid}`

/**
 * A standalone print page for rendered note HTML. `colors` are the print
 * theme's colorscheme tokens; the HTML must already be sanitized.
 */
export function printHtml({
  title,
  html,
  css,
  colors,
}: {
  title: string
  html: string
  css: string
  colors: Readonly<Record<string, string>>
}) {
  const tokens = Object.entries(colors)
    .map(([key, value]) => `--${key}:${value}`)
    .join(';')
  const style = `:root{color-scheme:light;${tokens};--space-2:8px;--space-3:12px;--space-4:16px}\n${css}\n${printCss}`
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}"><title>${escapeHtml(title)}</title><style>${style.replaceAll('</', '<\\/')}</style></head><body>${html}</body></html>`
}
