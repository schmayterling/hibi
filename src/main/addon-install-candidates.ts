import { randomUUID } from 'node:crypto'
import type { AddonManifest } from '../addons/api'
import {
  requiredAddonDependencies,
  resolveAddonDependencies,
  validateAddonRequirements,
} from '../shared/addon-dependencies'
import {
  admitInstalledAddon,
  parseAddonManifest,
  validId,
} from '../shared/addon-manifest'
import { MAX_ADDON_MANIFEST_BYTES } from '../shared/addon-package'
import type { AddonInstallCandidate, InstalledAddon } from '../shared/sideload'
import {
  type AddonInventory,
  addonCandidatePaths,
  addonPackageFiles,
} from './addon-inventory'

export type InstallCandidate = {
  review: AddonInstallCandidate
  folder: string
  id?: string
  data?: ReturnType<typeof admitInstalledAddon>
}

export function installationGraph(
  proposed: readonly AddonManifest[],
  builtins: readonly AddonManifest[],
  installed: readonly InstalledAddon[],
) {
  const ids = new Set(proposed.map((manifest) => manifest.id))
  return [
    ...builtins,
    ...installed
      .filter((addon) => !ids.has(addon.manifest.id))
      .map((addon) => addon.manifest),
    ...proposed,
  ]
}

/** Check replacements with the retained catalog, then order selected providers first. */
export function validateGraph(
  proposed: readonly AddonManifest[],
  builtins: readonly AddonManifest[],
  installed: readonly InstalledAddon[],
): string[] {
  const graph = installationGraph(proposed, builtins, installed)
  validateAddonRequirements(graph, { allowMissing: true })
  const ids = new Set(graph.map((manifest) => manifest.id))
  for (const manifest of proposed)
    for (const id of requiredAddonDependencies(graph, manifest.id))
      if (!ids.has(id))
        throw new Error(
          `Addon "${manifest.id}" requires unknown addon "${id}".`,
        )
  const selected = new Set(proposed.map((manifest) => manifest.id))
  return resolveAddonDependencies(
    graph,
    graph.map(({ id }) => ({ id, enabled: true })),
  ).order.filter((id) => selected.has(id))
}

function block(candidate: InstallCandidate, reason: string) {
  candidate.review.status = 'blocked'
  candidate.review.reasons.push(reason)
}

export async function inspectAddonCandidates(
  inventory: AddonInventory,
  builtins: readonly AddonManifest[],
  installed: readonly InstalledAddon[],
): Promise<InstallCandidate[]> {
  const candidates: InstallCandidate[] = []
  const prepared: InstallCandidate[] = []
  const values = new Map<
    InstallCandidate,
    { value: unknown; themeFiles: Map<string, unknown> }
  >()
  for (const folder of addonCandidatePaths(inventory)) {
    const candidate: InstallCandidate = {
      folder,
      review: {
        key: randomUUID(),
        folder: folder || '.',
        status: 'invalid',
        reasons: [],
      },
    }
    candidates.push(candidate)
    try {
      const path = folder ? `${folder}/hibi-addon.json` : 'hibi-addon.json'
      const bytes = await inventory.read(path)
      if (bytes.length > MAX_ADDON_MANIFEST_BYTES)
        throw new Error('hibi-addon.json must be no larger than 64 KiB.')
      const value: unknown = JSON.parse(bytes.toString('utf8'))
      if (
        value &&
        typeof value === 'object' &&
        'id' in value &&
        validId(value.id)
      )
        candidate.id = value.id
      const data = parseAddonManifest(value)
      candidate.review.manifest = data.manifest
      const files = addonPackageFiles(inventory, folder)
      const required = [
        data.entry,
        data.manifest.analysis?.entry,
        ...(data.styles ?? []),
        ...data.themes.filter((theme) => typeof theme === 'string'),
      ].filter((path): path is string => !!path)
      if (required.some((path) => !files.includes(path)))
        throw new Error(
          'The addon needs README.md and the entry files listed in hibi-addon.json.',
        )
      const themeFiles = new Map<string, unknown>()
      for (const theme of data.themes) {
        if (typeof theme !== 'string') continue
        const bytes = await inventory.read(
          folder ? `${folder}/${theme}` : theme,
        )
        if (bytes.length > MAX_ADDON_MANIFEST_BYTES)
          throw new Error('Addon theme files must be no larger than 64 KiB.')
        try {
          themeFiles.set(theme, JSON.parse(bytes.toString('utf8')))
        } catch {
          throw new Error(`The theme file ${theme} is not valid JSON.`)
        }
      }
      prepared.push(candidate)
      values.set(candidate, { value, themeFiles })
      candidate.review.status = 'installable'
    } catch (error) {
      candidate.review.reasons.push(
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  if (!candidates.length)
    throw new Error(
      'No hibi-addon.json was found in this folder or repository.',
    )
  // Conflicts use all prepared roots, before reserved IDs or provider policy.
  for (const candidate of prepared) {
    const duplicates = prepared.filter(
      (other) =>
        other !== candidate &&
        other.review.manifest!.id === candidate.review.manifest!.id,
    )
    if (duplicates.length)
      block(
        candidate,
        `Duplicate addon ID "${candidate.review.manifest!.id}" in: ${[candidate, ...duplicates].map((item) => item.review.folder).join(', ')}.`,
      )
    const overlaps = prepared.filter(
      (other) =>
        other !== candidate &&
        (!candidate.folder ||
          !other.folder ||
          other.folder.startsWith(`${candidate.folder}/`) ||
          candidate.folder.startsWith(`${other.folder}/`)),
    )
    if (overlaps.length)
      block(
        candidate,
        `Package folders overlap: ${[candidate, ...overlaps].map((item) => item.review.folder).join(', ')}. Ask the publisher to separate these packages.`,
      )
    try {
      const { value, themeFiles } = values.get(candidate)!
      candidate.data = admitInstalledAddon(
        value,
        builtins.map((manifest) => manifest.id),
        'install',
        { themeFiles },
      )
    } catch (error) {
      block(candidate, error instanceof Error ? error.message : String(error))
    }
    const previous = installed.find(
      (addon) => addon.manifest.id === candidate.review.manifest!.id,
    )
    if (previous)
      candidate.review.replaces = {
        version: previous.manifest.version,
        source: previous.source ?? 'local',
      }
  }
  validateCandidateSelection(candidates, builtins, installed)
  return candidates
}

export function validateCandidateSelection(
  candidates: InstallCandidate[],
  builtins: readonly AddonManifest[],
  installed: readonly InstalledAddon[],
): string[] {
  const available = () =>
    candidates.filter((candidate) => candidate.review.status === 'installable')
  // A rejected provider cannot make its consumers installable.
  while (true) {
    const eligible = available()
    const graph = installationGraph(
      eligible.map((candidate) => candidate.data!.manifest),
      builtins,
      installed,
    )
    const byId = new Map(graph.map((manifest) => [manifest.id, manifest]))
    const cyclic = (id: string) => {
      const visited = new Set<string>()
      const reachesOwner = (owner: string): boolean => {
        for (const dependency of byId.get(owner)?.requires?.addons ?? []) {
          if (dependency.id === id) return true
          if (visited.has(dependency.id)) continue
          visited.add(dependency.id)
          if (reachesOwner(dependency.id)) return true
        }
        return false
      }
      return reachesOwner(id)
    }
    const cycles = eligible.filter((candidate) =>
      cyclic(candidate.data!.manifest.id),
    )
    if (cycles.length) {
      for (const candidate of cycles)
        block(
          candidate,
          `Addon dependency cycle involving "${candidate.data!.manifest.id}".`,
        )
      continue
    }
    let changed = false
    for (const candidate of eligible) {
      const missing = requiredAddonDependencies(
        graph,
        candidate.data!.manifest.id,
      ).filter((id) => !byId.has(id))
      if (!missing.length) continue
      changed = true
      for (const id of missing) {
        const paths = candidates
          .filter((item) => item.id === id)
          .map((item) => item.review.folder)
        block(
          candidate,
          `Requires unavailable addon "${id}"${paths.length ? ` (${paths.join(', ')})` : ''}.`,
        )
      }
    }
    if (!changed) break
  }
  return validateGraph(
    available().map((candidate) => candidate.data!.manifest),
    builtins,
    installed,
  )
}
