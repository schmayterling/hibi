import type {
  RenderedMarkdown,
  SiteExportContribution,
  SiteExportPage,
} from '../../addons/api'

type Contribution = SiteExportContribution & { id: string; name: string }
const registry = new Map<string, Contribution>()
let version = 0

/** Enabled addons contribute data and export-time transforms, never site runtime code. */
export const siteContributions = {
  version: () => version,
  snapshot: () => [...registry.values()],
  register(id: string, name: string, contribution: SiteExportContribution) {
    if (
      registry.has(id) ||
      typeof contribution.description !== 'string' ||
      contribution.description.length > 500 ||
      (contribution.css !== undefined &&
        (typeof contribution.css !== 'string' ||
          contribution.css.length > 128 * 1024)) ||
      (contribution.transform !== undefined &&
        typeof contribution.transform !== 'function')
    )
      throw new Error(
        'This addon supplied an invalid or duplicate site contribution.',
      )
    const entry = { ...contribution, id, name }
    registry.set(id, entry)
    version++
    return () => {
      if (registry.get(id) !== entry) return
      registry.delete(id)
      version++
    }
  },
  async render(
    rendered: RenderedMarkdown,
    page: SiteExportPage,
    contributions: readonly Contribution[],
    signal?: AbortSignal,
  ) {
    for (const contribution of contributions) {
      signal?.throwIfAborted()
      if (registry.get(contribution.id) !== contribution)
        throw new Error('Enabled addons changed during export. Export again.')
      if (contribution.transform) {
        rendered = await contribution.transform(
          rendered,
          Object.freeze({ ...page }),
        )
        if (
          !rendered ||
          typeof rendered.html !== 'string' ||
          typeof rendered.css !== 'string'
        )
          throw new Error(
            `The ${contribution.name} addon returned an invalid site page.`,
          )
      }
      if (registry.get(contribution.id) !== contribution)
        throw new Error('Enabled addons changed during export. Export again.')
    }
    signal?.throwIfAborted()
    return rendered
  },
}
