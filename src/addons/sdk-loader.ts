import type { Addon, AddonCapability } from './api'

/** Optional fields are loaded only when requested by a new package's manifest. */
export type CapabilitySdk = {
  React?: typeof import('react')
  ui?: typeof import('./ui')
  /**
   * @deprecated Available only when the rich capability is requested in the legacy editor.
   * @throws Access in the CodeMirror formatted engine throws an update-required error.
   * Check codeMirror.markdown first when supporting both editor engines.
   */
  tiptap?: typeof import('@tiptap/core')
  codeMirror?: typeof import('./sdk-source') & {
    common?: typeof import('@lezer/common')
    markdown?: typeof import('@lezer/markdown')
  }
  markdown?: { Marked: typeof import('marked').Marked }
  documents: typeof import('../shared/document-projection')
}
export type CapabilityFactory = (sdk: CapabilitySdk) => Omit<Addon, 'manifest'>
export async function loadAddonSdk(
  capabilities: readonly AddonCapability[] | undefined,
  formatted = false,
) {
  if (capabilities === undefined) return (await import('./sdk')).sdk
  const sdk: CapabilitySdk = {
    documents: await import('../shared/document-projection'),
  }
  await Promise.all(
    capabilities.map(async (capability) => {
      if (capability === 'ui')
        [sdk.React, sdk.ui] = await Promise.all([
          import('react'),
          import('./ui'),
        ])
      else if (capability === 'rich') {
        if (formatted) (await import('./sdk-legacy-rich')).withoutRichSdk(sdk)
        else sdk.tiptap = await import('@tiptap/core')
      } else if (capability === 'source' || capability === 'formatted')
        sdk.codeMirror = capabilities.includes('formatted')
          ? await import('./sdk-formatted')
          : await import('./sdk-source')
      else if (capability === 'markdown')
        sdk.markdown = { Marked: (await import('marked')).Marked }
    }),
  )
  return sdk
}
