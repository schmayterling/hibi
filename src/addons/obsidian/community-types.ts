export type CommunityEntry = {
  kind: 'plugin' | 'theme'
  id: string
  name: string
  author: string
  description: string
  repo: string
  downloads: number
  updated: number
  branch?: string
  screenshot?: string
  modes?: string[]
}
export type CommunityDirectory = {
  entries: CommunityEntry[]
  fetchedAt: string | null
  error?: string
}
export type CommunityDetails = {
  readme: string
  readmeUrl: string
  release: string | null
  version?: string
  minAppVersion?: string
  desktopOnly?: boolean
  error?: string
}
export const validCommunityRepo = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 200 &&
  /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/.test(value) &&
  !['.', '..'].includes(value.split('/')[1]!) &&
  !value.endsWith('.git')
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= max
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0

/** Directory metadata supplies discovery, never trust or executable paths. */
export function parseCommunityEntries(
  value: unknown,
  kind: CommunityEntry['kind'],
  stats: unknown = {},
): CommunityEntry[] {
  if (!Array.isArray(value) || value.length > 20000)
    throw new Error('The Obsidian community directory is invalid.')
  const seen = new Set<string>()
  return value.map((row: unknown) => {
    if (
      !object(row) ||
      !text(row.name, 200) ||
      !text(row.author, 500) ||
      !validCommunityRepo(row.repo) ||
      (kind === 'plugin' &&
        (!text(row.id, 100) || !text(row.description, 4000)))
    )
      throw new Error(
        'The Obsidian community directory contains an invalid entry.',
      )
    const id = kind === 'plugin' ? String(row.id) : row.name
    if (seen.has(id))
      throw new Error(
        'The Obsidian community directory contains duplicate entries.',
      )
    seen.add(id)
    const usage =
      object(stats) && Object.hasOwn(stats, id) && object(stats[id])
        ? stats[id]
        : {}
    const entry: CommunityEntry = {
      kind,
      id,
      name: row.name,
      author: row.author,
      repo: row.repo,
      description: kind === 'plugin' ? String(row.description) : '',
      downloads: count(usage.downloads),
      updated: count(usage.updated),
    }
    if (row.branch !== undefined) {
      if (!text(row.branch, 200) || /[\s\\?#\p{Cc}]/u.test(row.branch))
        throw new Error('The community theme branch is invalid.')
      entry.branch = row.branch
    }
    if (row.screenshot !== undefined && row.screenshot !== '') {
      if (!text(row.screenshot, 1000))
        throw new Error('The community screenshot is invalid.')
      entry.screenshot = row.screenshot
    }
    if (row.modes !== undefined) {
      if (
        !Array.isArray(row.modes) ||
        !row.modes.every((mode) => mode === 'dark' || mode === 'light')
      )
        throw new Error('The community theme modes are invalid.')
      entry.modes = row.modes
    }
    return entry
  })
}

export function filterCommunityEntries(
  entries: readonly CommunityEntry[],
  kind: CommunityEntry['kind'] | null,
  query: string,
  sort: 'downloads' | 'name' | 'updated',
) {
  const search = query.trim().toLocaleLowerCase()
  return entries
    .filter(
      (entry) =>
        (!kind || entry.kind === kind) &&
        [entry.id, entry.name, entry.author, entry.description, entry.repo]
          .join(' ')
          .toLocaleLowerCase()
          .includes(search),
    )
    .toSorted(
      (a, b) =>
        (sort === 'name' ? 0 : b[sort] - a[sort]) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
        a.id.localeCompare(b.id),
    )
}
