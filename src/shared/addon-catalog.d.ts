declare module 'virtual:hibi-addon-catalog/main' {
  const catalog: {
    manifest: import('../addons/api').AddonManifest
    source: 'built-in' | 'local'
    directory: string
    loadNative?: () => Promise<import('../addons/api').NativeAddon>
  }[]
  export default catalog
}

declare module 'virtual:hibi-addon-catalog/renderer' {
  const catalog: {
    manifest: import('../addons/api').AddonManifest
    source: 'built-in' | 'local'
    load: () => Promise<{ default: unknown }>
    loadResources?: () => Promise<{
      styles: string[]
      themes: import('../shared/colorschemes').ColorschemeInput[]
    }>
    loadSettings?: () => Promise<{ Settings: import('react').ComponentType }>
    flavors?: readonly import('../addons/api').MarkdownFlavor[]
  }[]
  export default catalog
}

declare module 'virtual:hibi-addon-catalog/windows' {
  const catalog: {
    id: string
    capabilities?: import('../addons/api').AddonManifest['capabilities']
    load: () => Promise<{ default: unknown }>
    loadResources?: () => Promise<{
      styles: string[]
      themes: import('../shared/colorschemes').ColorschemeInput[]
    }>
  }[]
  export default catalog
}

declare module 'virtual:hibi-addon-catalog/details' {
  const details: Record<
    string,
    Pick<import('../addons/api').AddonManifest, 'authors' | 'licenses'>
  >
  export default details
}
