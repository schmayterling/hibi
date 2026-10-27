import {
  ADDON_API_VERSION,
  type AddonManifest,
  compatibleAddonManifest,
} from '../addons/api'
import { parseAddonRequirements } from './addon-dependencies'
import { validCommandMenu } from './addon-hotkeys'
import {
  MAX_ADDON_MANIFEST_BYTES,
  validAddonPath as validPath,
} from './addon-package'
import { type ColorschemeInput, defineColorscheme } from './colorschemes'
import { parseDependencies } from './dependencies'
import { validDocumentExtensions } from './document-types'
import { parseAddonNetwork } from './host-network'
import { parseSyntaxDescriptors } from './preservation'

export const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value)

function settingsMetadata(
  value: unknown,
): NonNullable<AddonManifest['settings']> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The addon settings metadata is invalid.')
  const { category, icon } = value as Record<string, unknown>
  if (
    [category, icon].some(
      (field) =>
        field !== undefined &&
        (typeof field !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(field)),
    )
  )
    throw new Error('The addon settings category or icon is invalid.')
  return {
    ...(typeof category === 'string' ? { category } : {}),
    ...(typeof icon === 'string' ? { icon } : {}),
  }
}

export type ParsedAddonManifest = {
  manifest: AddonManifest
  entry: string
  styles?: string[]
  native?: { entry: string }
  themes: (ColorschemeInput | string)[]
}

/** `themeFiles` holds parsed JSON by declared path; without it, theme paths stay unresolved. */
export function parseAddonManifest(
  value: unknown,
  {
    trust = 'installed',
    themeFiles,
  }: {
    trust?: 'installed' | 'compiled'
    themeFiles?: ReadonlyMap<string, unknown> | undefined
  } = {},
): ParsedAddonManifest {
  if (!value || typeof value !== 'object')
    throw new Error('The addon details in hibi-addon.json are invalid.')
  const data = value as Record<string, unknown>
  const modulePath = (entry: unknown): entry is string =>
    validPath(entry) &&
    (trust === 'compiled' ? /\.(m?js|tsx?)$/ : /\.m?js$/).test(entry)
  let native: ParsedAddonManifest['native']
  if (trust === 'compiled' && data.native !== undefined) {
    const entry =
      data.native &&
      typeof data.native === 'object' &&
      !Array.isArray(data.native)
        ? (data.native as { entry?: unknown }).entry
        : undefined
    if (!modulePath(entry))
      throw new Error(
        'The native entry must be a module inside the addon folder.',
      )
    native = { entry }
  }
  const string = (value: unknown, max: number): value is string =>
    typeof value === 'string' && !!value.trim() && value.length <= max
  if (
    !validId(data.id) ||
    !string(data.name, 100) ||
    !string(data.description, 500) ||
    !compatibleAddonManifest(data) ||
    !['theme', 'extension'].includes(String(data.kind)) ||
    !string(data.version, 40) ||
    ((trust === 'installed' || data.authors !== undefined) &&
      (!Array.isArray(data.authors) ||
        (trust === 'installed' && !data.authors.length) ||
        data.authors.length > 20 ||
        data.authors.some(
          (author) =>
            !author ||
            !string(author.displayName, 100) ||
            (author.discordId !== undefined &&
              (typeof author.discordId !== 'string' ||
                !/^\d{5,24}$/.test(author.discordId))) ||
            (author.github !== undefined &&
              (typeof author.github !== 'string' ||
                !/^[a-z\d-]{1,39}$/i.test(author.github))) ||
            (author.role !== undefined && !string(author.role, 100)),
        )))
  )
    throw new Error(
      'The addon needs an ID, kind, API version, version, description, and authors in hibi-addon.json.',
    )
  if (
    data.licenses !== undefined &&
    (!Array.isArray(data.licenses) ||
      data.licenses.length > 50 ||
      data.licenses.some(
        (license) =>
          !license ||
          !validId(license.id) ||
          !string(license.name, 100) ||
          !string(license.license, 100) ||
          !string(license.text, MAX_ADDON_MANIFEST_BYTES) ||
          // Installed manifests hit the file cap first; compiled manifests need this byte check.
          new TextEncoder().encode(license.text).length >
            MAX_ADDON_MANIFEST_BYTES,
      ))
  )
    throw new Error('The addon license details are invalid.')
  if (
    data.fileExtensions !== undefined &&
    (data.kind === 'theme' || !validDocumentExtensions(data.fileExtensions))
  )
    throw new Error('The addon lists invalid file extensions.')
  if (
    data.capabilities !== undefined &&
    (!Array.isArray(data.capabilities) ||
      data.capabilities.length > 6 ||
      new Set(data.capabilities).size !== data.capabilities.length ||
      data.capabilities.some(
        (value) =>
          ![
            'ui',
            'rich',
            'source',
            'formatted',
            'markdown',
            'modalEditing',
          ].includes(value) ||
          (value === 'formatted' && data.apiVersion !== 3),
      ))
  )
    throw new Error('The addon lists invalid SDK capabilities.')
  if (
    data.activation !== undefined &&
    (!['command', 'source', 'rich', 'formatted'].includes(
      String(data.activation),
    ) ||
      (data.activation === 'formatted' && data.apiVersion !== 3))
  )
    throw new Error('The addon activation mode is invalid.')
  if (
    data.commands !== undefined &&
    (!Array.isArray(data.commands) ||
      data.commands.length > 64 ||
      new Set(data.commands.map((command) => command?.id)).size !==
        data.commands.length ||
      data.commands.some(
        (command) =>
          !command ||
          !validId(command.id) ||
          !string(command.label, 100) ||
          (command.keywords !== undefined && !string(command.keywords, 300)) ||
          (command.menu !== undefined && !validCommandMenu(command.menu)),
      ))
  )
    throw new Error('The addon command descriptors are invalid.')
  if (
    data.activation === 'command' &&
    (!Array.isArray(data.commands) || !data.commands.length)
  )
    throw new Error('Command-activated addons must declare their commands.')
  if (data.activation !== undefined && data.capabilities === undefined)
    throw new Error(
      'Declare SDK capabilities before choosing an activation mode.',
    )
  const requires = parseAddonRequirements(data.requires, data.id)
  const base: AddonManifest = {
    id: data.id,
    name: data.name,
    description: data.description,
    apiVersion: ADDON_API_VERSION,
    kind: data.kind as 'theme' | 'extension',
    version: data.version,
    ...(Array.isArray(data.authors) ? { authors: data.authors } : {}),
    defaultEnabled: data.defaultEnabled === true,
    ...(data.network === undefined
      ? {}
      : { network: parseAddonNetwork(data.network) }),
    ...(data.dependencies === undefined
      ? {}
      : { dependencies: parseDependencies(data.dependencies) }),
    ...(requires === undefined ? {} : { requires }),
    ...(data.settings === undefined
      ? {}
      : { settings: settingsMetadata(data.settings) }),
    ...(data.analysis === undefined
      ? {}
      : { analysis: parseAnalysis(data.analysis, trust) }),
    ...(trust !== 'compiled' || data.importer === undefined
      ? {}
      : { importer: parseImporter(data.importer) }),
    ...(data.syntax === undefined
      ? {}
      : { syntax: parseSyntaxDescriptors(data.syntax)! }),
    ...(data.capabilities === undefined
      ? {}
      : {
          capabilities: data.capabilities as NonNullable<
            AddonManifest['capabilities']
          >,
        }),
    ...(data.activation === undefined
      ? {}
      : {
          activation: data.activation as NonNullable<
            AddonManifest['activation']
          >,
        }),
    ...(data.commands === undefined
      ? {}
      : { commands: data.commands as NonNullable<AddonManifest['commands']> }),
    ...(data.startup === 'background'
      ? { startup: 'background' as const }
      : {}),
    ...(data.fileExtensions !== undefined
      ? {
          fileExtensions: data.fileExtensions,
        }
      : {}),
    ...(data.licenses
      ? { licenses: data.licenses as NonNullable<AddonManifest['licenses']> }
      : {}),
  }
  if (
    data.styles !== undefined &&
    (!Array.isArray(data.styles) ||
      data.styles.length > 16 ||
      new Set(data.styles).size !== data.styles.length ||
      data.styles.some((path) => !validPath(path) || !path.endsWith('.css')))
  )
    throw new Error(
      'The addon styles must be unique CSS paths inside the addon folder.',
    )
  if (
    data.themes !== undefined &&
    (!Array.isArray(data.themes) || data.themes.length > 20)
  )
    throw new Error('The addon can declare up to 20 color schemes.')
  const themes =
    (data.themes as unknown[] | undefined)?.map((entry) => {
      let value = entry
      if (typeof entry === 'string') {
        if (!validPath(entry) || !entry.endsWith('.json'))
          throw new Error(
            'Theme files must be JSON paths inside the addon folder.',
          )
        if (!themeFiles) return entry
        value = themeFiles.get(entry)
      }
      try {
        if (
          !value ||
          typeof value !== 'object' ||
          !('colors' in value) ||
          !value.colors ||
          typeof value.colors !== 'object'
        )
          throw new Error('This theme has an invalid color scheme.')
        return defineColorscheme(value as ColorschemeInput)
      } catch (error) {
        if (typeof entry !== 'string') throw error
        throw new Error(
          `The theme file ${entry} has an invalid color scheme. ${(error as Error).message}`,
        )
      }
    }) ?? []
  const inlineThemes = themes.filter((theme) => typeof theme !== 'string')
  const themePaths = themes.filter((theme) => typeof theme === 'string')
  if (
    inlineThemes.some((theme) => !validId(theme.id)) ||
    new Set(inlineThemes.map((theme) => theme.id)).size !==
      inlineThemes.length ||
    new Set(themePaths).size !== themePaths.length
  )
    throw new Error('Each theme needs a valid, unique ID or path.')
  if (
    base.kind === 'theme' &&
    (trust === 'installed' || data.entry === undefined)
  ) {
    if (
      data.native !== undefined ||
      data.importer !== undefined ||
      data.analysis !== undefined ||
      data.syntax !== undefined ||
      data.capabilities !== undefined ||
      data.activation !== undefined ||
      data.commands !== undefined ||
      data.dependencies !== undefined ||
      data.entry !== undefined ||
      data.styles !== undefined ||
      !themes.length
    )
      throw new Error(
        'Themes must contain color schemes without executable code.',
      )
    base.licenses = [
      ...(base.licenses ?? []),
      ...inlineThemes.map((theme) => ({
        id: `theme-${theme.id}`,
        name: theme.name,
        license: theme.license.name,
        text: theme.license.text,
      })),
    ]
    return { manifest: base, entry: '', themes }
  }
  if (!modulePath(data.entry))
    throw new Error(
      trust === 'compiled'
        ? 'The extension entry must point to a .ts, .tsx, .js or .mjs file inside the addon folder.'
        : 'The extension entry must point to a .js or .mjs file inside the addon folder.',
    )
  return {
    manifest: base,
    entry: data.entry,
    themes,
    ...(native === undefined ? {} : { native }),
    ...(data.styles === undefined ? {} : { styles: data.styles as string[] }),
  }
}
/** `load` ignores declarations that packages installed before resource validation never had checked. */
export function admitInstalledAddon(
  value: unknown,
  compiledIds: readonly string[],
  phase: 'install' | 'load' = 'install',
  {
    themeFiles,
  }: { themeFiles?: ReadonlyMap<string, unknown> | undefined } = {},
): {
  manifest: AddonManifest
  entry: string
  themes: ColorschemeInput[]
  styles?: string[]
} {
  if (phase === 'load' && value && typeof value === 'object') {
    const data = value as Record<string, unknown>
    value = {
      ...data,
      styles: undefined,
      native: undefined,
      importer: undefined,
      windows: undefined,
      ...(data.kind === 'extension' ? { themes: undefined } : {}),
    }
  }
  const parsed = parseAddonManifest(value, { themeFiles })
  const data = value as Record<string, unknown>
  if (compiledIds.includes(parsed.manifest.id))
    throw new Error(
      'This addon uses the ID of a built-in addon and cannot replace it.',
    )
  if (['native', 'importer', 'windows'].some((key) => data[key] !== undefined))
    throw new Error(
      'Installed addons cannot declare native handlers, importers, or windows.',
    )
  if (parsed.manifest.capabilities?.includes('modalEditing'))
    throw new Error('The addon lists invalid SDK capabilities.')
  const themes = parsed.themes.filter((theme) => typeof theme !== 'string')
  if (themes.length !== parsed.themes.length)
    throw new Error('The addon theme files could not be read.')
  return {
    manifest: { ...parsed.manifest, defaultEnabled: false },
    entry: parsed.entry,
    themes,
    ...(parsed.styles ? { styles: parsed.styles } : {}),
  }
}

function parseImporter(value: unknown): NonNullable<AddonManifest['importer']> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The addon importer metadata is invalid.')
  const { instructions, sources } = value as Record<string, unknown>
  if (
    typeof instructions !== 'string' ||
    !Array.isArray(sources) ||
    sources.some((source) => source !== 'folder' && source !== 'zip')
  )
    throw new Error('The addon importer instructions or sources are invalid.')
  return { instructions, sources }
}

function parseAnalysis(
  value: unknown,
  trust: 'installed' | 'compiled',
): { entry: string } {
  const entry =
    value && typeof value === 'object'
      ? (value as { entry?: unknown }).entry
      : undefined
  if (
    !validPath(entry) ||
    !(trust === 'compiled' ? /\.(m?js|ts)$/ : /\.m?js$/).test(entry)
  )
    throw new Error(
      'The analysis entry must be a JavaScript module inside the addon folder.',
    )
  return { entry }
}
