import type {
  AddonStorageHandle,
  AddonStorageReadResult,
} from '../../shared/addon-storage'
import type { ThemePreferences } from '../../shared/colorschemes'
import {
  type ExportOptions,
  exportOptions,
  validateExportOptions,
} from './options.ts'

/** Publishing must not guess whether unreadable or unmigrated preferences are protected. */
export async function publishingOptions(
  store: AddonStorageHandle<ExportOptions>,
  legacyText: string | null,
  name: string,
  theme: ThemePreferences,
  input: Partial<ExportOptions> = {},
): Promise<ExportOptions> {
  const saved = store.snapshot()
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.hasOwn(input, 'passwordProtected') ||
    !['ready', 'missing'].includes(saved.status) ||
    (saved.status === 'missing' && legacyText !== null)
  )
    throw new Error('Review and save export options before publishing.')
  const loaded = await loadExportOptions(store, null, name, theme)
  if (loaded.warning || !loaded.canSave)
    throw new Error('Review and save export options before publishing.')
  if (loaded.initial.passwordProtected)
    throw new Error(
      'Turn off password protection in export options before publishing.',
    )
  return validateExportOptions(
    exportOptions(
      {
        ...loaded.initial,
        ...input,
        singleFile: false,
      },
      name,
      theme,
    ),
  )
}

type LoadedOptions = {
  initial: ExportOptions
  warning: string | null
  canSave: boolean
}

/** Keep legacy data until its new workspace-scoped copy is durably acknowledged. */
export async function loadExportOptions(
  store: AddonStorageHandle<ExportOptions>,
  legacyText: string | null,
  name: string,
  theme: ThemePreferences,
): Promise<LoadedOptions> {
  const fallback = exportOptions({}, name, theme)
  const normalized = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid saved export options.')
    return validateExportOptions(exportOptions(value, name, theme))
  }
  const storedValue = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid saved export options.')
    const item = value as Record<string, unknown>
    for (const key of [
      'title',
      'description',
      'author',
      'language',
      'url',
      'socialImage',
      'logo',
      'favicon',
      'css',
    ])
      if (typeof item[key] !== 'string')
        throw new Error('Invalid saved export options.')
    for (const key of [
      'singleFile',
      'autoSeo',
      'indexing',
      'graph',
      'lockTheme',
      'passwordProtected',
    ])
      if (typeof item[key] !== 'boolean')
        throw new Error('Invalid saved export options.')
    if (
      !item.theme ||
      typeof item.theme !== 'object' ||
      Array.isArray(item.theme)
    )
      throw new Error('Invalid saved export options.')
    const savedTheme = item.theme as Record<string, unknown>
    const options = normalized(value)
    if (
      options.theme.mode !== savedTheme.mode ||
      options.theme.light !== savedTheme.light ||
      options.theme.dark !== savedTheme.dark
    )
      throw new Error('Invalid saved export options.')
    return options
  }
  const stored = (current: AddonStorageReadResult): LoadedOptions => {
    if (current.status !== 'ready')
      return {
        initial: fallback,
        warning:
          'Saved export options use a different version. Defaults are shown, and stored options will not be changed.',
        canSave: false,
      }
    try {
      return {
        initial: storedValue(current.value),
        warning: null,
        canSave: true,
      }
    } catch {
      return {
        initial: fallback,
        warning:
          'Saved export options could not be read. Defaults are shown, and stored options will not be changed.',
        canSave: false,
      }
    }
  }
  const current = store.snapshot()
  if (current.status === 'ready') return stored(current)
  if (current.status === 'version-mismatch') return stored(current)
  if (current.status === 'unavailable') {
    if (
      current.reason === 'stale-workspace' ||
      current.reason === 'stale-activation'
    )
      throw new Error('Workspace or addon changed. Open export again.')
    return {
      initial: fallback,
      warning:
        'Saved export options are unavailable. Defaults are shown, and stored options will not be changed.',
      canSave: false,
    }
  }
  if (legacyText === null)
    return { initial: fallback, warning: null, canSave: true }
  let legacy: ExportOptions
  try {
    legacy = normalized(JSON.parse(legacyText))
  } catch {
    return {
      initial: fallback,
      warning:
        'Earlier export options could not be read. Defaults are shown; the original copy remains untouched.',
      canSave: true,
    }
  }
  try {
    const migrated = await store.set(legacy)
    if (migrated.status === 'saved')
      return { initial: legacy, warning: null, canSave: true }
    if (migrated.status === 'conflict') return stored(migrated.current)
  } catch {
    // The legacy copy remains available if the durable write fails.
  }
  return {
    initial: legacy,
    warning:
      'Earlier export options could not be moved into workspace storage. The original copy remains untouched.',
    canSave: false,
  }
}
