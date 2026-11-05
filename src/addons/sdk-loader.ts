import type { Addon, AddonCapability } from './api'

/** Optional fields are loaded only when requested by a new package's manifest. */
export type CapabilitySdk = {
  React?: typeof import('react')
  ui?: typeof import('./ui')
  codeMirror?: typeof import('./sdk-source') & {
    common?: typeof import('@lezer/common')
    markdown?: typeof import('@lezer/markdown')
  }
  markdown?: { Marked: typeof import('marked').Marked }
  documents: typeof import('../shared/document-projection')
}
export type CapabilityFactory = (sdk: CapabilitySdk) => Omit<Addon, 'manifest'>
export async function loadAddonSdk(requested: readonly AddonCapability[]) {
  const sdk: CapabilitySdk = {
    documents: await import('../shared/document-projection'),
  }
  await Promise.all(
    requested.map(async (capability) => {
      if (capability === 'ui')
        [sdk.React, sdk.ui] = await Promise.all([
          import('react'),
          import('./ui'),
        ])
      else if (capability === 'source' || capability === 'formatted')
        sdk.codeMirror = requested.includes('formatted')
          ? await import('./sdk-formatted')
          : await import('./sdk-source')
      else if (capability === 'markdown')
        sdk.markdown = { Marked: (await import('marked')).Marked }
    }),
  )
  return sdk
}
