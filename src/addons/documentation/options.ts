import {
  DEFAULT_THEME,
  type ThemePreferences,
  themePreferences,
} from '../../shared/colorschemes.ts'

export type ExportOptions = {
  singleFile: boolean
  title: string
  description: string
  author: string
  language: string
  url: string
  socialImage: string
  logo: string
  favicon: string
  autoSeo: boolean
  indexing: boolean
  graph: boolean
  lockTheme: boolean
  passwordProtected: boolean
  theme: ThemePreferences
  css: string
  /** Workspace path of the landing page; empty uses README, index, or the first page. */
  homePage: string
  footer: string
  contentWidth: 'normal' | 'wide'
  outline: boolean
  pagination: boolean
  /** Addon id to whether its site contribution is included; missing ids are included. */
  addons: Record<string, boolean>
}

export function exportOptions(
  value: unknown = {},
  title = '',
  theme = DEFAULT_THEME,
): ExportOptions {
  const input =
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const text = (key: string, fallback = '') =>
    typeof input[key] === 'string' ? (input[key] as string) : fallback
  return {
    singleFile: input.singleFile !== false,
    title: text('title', title),
    description: text('description'),
    author: text('author'),
    language: text('language', 'en'),
    url: text('url'),
    socialImage: text('socialImage'),
    logo: text('logo'),
    favicon: text('favicon'),
    css: text('css'),
    autoSeo: input.autoSeo !== false,
    indexing: input.indexing !== false,
    graph: input.graph !== false,
    lockTheme: input.lockTheme === true,
    passwordProtected: input.passwordProtected === true,
    theme: themePreferences(input.theme ?? theme),
    homePage: text('homePage'),
    footer: text('footer'),
    contentWidth: input.contentWidth === 'wide' ? 'wide' : 'normal',
    outline: input.outline !== false,
    pagination: input.pagination !== false,
    addons: Object.fromEntries(
      Object.entries(
        input.addons && typeof input.addons === 'object'
          ? (input.addons as Record<string, unknown>)
          : {},
      ).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
      ),
    ),
  }
}

export function validateExportOptions(value: unknown): ExportOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Choose valid export options.')
  const options = exportOptions(value)
  for (const key of [
    'title',
    'description',
    'author',
    'language',
    'url',
    'socialImage',
    'homePage',
    'footer',
  ] as const)
    if (
      options[key].length >
      (key === 'url' || key === 'socialImage' || key === 'homePage'
        ? 2048
        : 500)
    )
      throw new Error('Shorten the site details before exporting.')
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(options.language))
    throw new Error('Use a language code such as en or en-US.')
  for (const key of ['url', 'socialImage'] as const) {
    if (!options[key]) continue
    let url: URL
    try {
      url = new URL(options[key])
    } catch {
      throw new Error('Use a complete HTTP or HTTPS URL.')
    }
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error('Use a complete HTTP or HTTPS URL without credentials.')
    if (key === 'url') {
      url.search = ''
      url.hash = ''
      if (!options.singleFile && !url.pathname.endsWith('/'))
        url.pathname += '/'
      options.url = url.href
    }
  }
  for (const key of ['logo', 'favicon'] as const)
    if (
      options[key] &&
      (!/^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml);base64,[a-z\d+/=]+$/i.test(
        options[key],
      ) ||
        options[key].length > 4 * 1024 * 1024)
    )
      throw new Error('Choose a logo or favicon smaller than 3 MiB.')
  const addons = Object.keys(options.addons)
  if (
    addons.length > 100 ||
    addons.some((id) => !/^[a-z][a-z0-9-]{0,47}$/.test(id))
  )
    throw new Error('Choose valid site addons.')
  if (options.css.length > 128 * 1024)
    throw new Error('Keep CSS overrides below 128 KB.')
  return options
}
