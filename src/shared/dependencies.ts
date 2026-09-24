/** A CLI required by an addon. Installers are package IDs, never shell commands. */
export type AddonDependency = {
  id: string
  name: string
  command: string
  homepage: string
  reason: string
  optional?: boolean
  install?: {
    brew?: { package: string; cask?: boolean }
    winget?: string
  }
}

export type DependencyState = {
  /** Opaque host key shared by identical declarations. */
  key: string
  id: string
  name: string
  command: string
  homepage: string
  status: 'available' | 'missing' | 'error' | 'installing'
  path: string | null
  customPath: boolean
  version?: string
  message?: string
  installer: { manager: string; command: string } | null
  addons: {
    id: string
    name: string
    enabled: boolean
    reason: string
    optional: boolean
  }[]
}

/** Requirements come from your manifest and remain visible while the addon is disabled. */
export type DependencyApi = {
  list: () => Promise<DependencyState[]>
  /** Check only a declared dependency, including its --version output. */
  check: (id: string) => Promise<DependencyState>
  /** Offer installation with a native confirmation before running a package manager. */
  install: (id: string) => Promise<DependencyState>
  openSettings: () => void
}

export const dependencyChangedEvent = 'hibi:dependencies-changed'

export const DEPENDENCY_CHANNELS = {
  list: 'dependencies:list',
  check: 'dependencies:check',
  install: 'dependencies:install',
  path: 'dependencies:path',
  guide: 'dependencies:guide',
} as const

export function parseDependencies(value: unknown): AddonDependency[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 24)
    throw new Error('An addon can declare up to 24 dependencies.')
  const ids = new Set<string>()
  const text = (value: unknown, limit: number): value is string =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= limit &&
    !Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  return value.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      !text(item.id, 64) ||
      !/^[a-z][a-z0-9-]*$/.test(item.id) ||
      ids.has(item.id) ||
      !text(item.name, 100) ||
      !text(item.reason, 500) ||
      !text(item.command, 80) ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(item.command) ||
      item.command.includes('..') ||
      !text(item.homepage, 2048) ||
      (item.optional !== undefined && typeof item.optional !== 'boolean')
    )
      throw new Error('The addon dependency declaration is invalid.')
    const url = new URL(item.homepage)
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Dependency installation guides must use HTTPS.')
    const install = item.install
    if (
      install !== undefined &&
      (!install ||
        typeof install !== 'object' ||
        Array.isArray(install) ||
        Object.keys(install).some((key) => !['brew', 'winget'].includes(key)))
    )
      throw new Error('Unsupported dependency installer.')
    const brew = install?.brew
    if (
      brew !== undefined &&
      (!brew ||
        typeof brew !== 'object' ||
        !text(brew.package, 100) ||
        !/^[a-z0-9][a-z0-9+@._-]*$/.test(brew.package) ||
        brew.package.includes('..') ||
        brew.package.endsWith('.rb') ||
        (brew.cask !== undefined && typeof brew.cask !== 'boolean'))
    )
      throw new Error('Invalid Homebrew package ID.')
    if (
      install?.winget !== undefined &&
      (!text(install.winget, 150) ||
        !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(install.winget) ||
        install.winget.includes('..'))
    )
      throw new Error('Invalid WinGet package ID.')
    ids.add(item.id)
    return {
      id: item.id,
      name: item.name,
      command: item.command,
      homepage: url.href,
      reason: item.reason,
      ...(item.optional === undefined ? {} : { optional: item.optional }),
      ...(install
        ? {
            install: {
              ...(brew
                ? {
                    brew: {
                      package: brew.package,
                      ...(brew.cask === undefined ? {} : { cask: brew.cask }),
                    },
                  }
                : {}),
              ...(install.winget ? { winget: install.winget } : {}),
            },
          }
        : {}),
    }
  })
}

/** Identical tools are shared even when addons describe different uses. */
export function dependencyIdentity({
  reason: _reason,
  optional: _optional,
  ...tool
}: AddonDependency) {
  return JSON.stringify(tool)
}

export function dependencyInstallCommand(
  dependency: AddonDependency,
  platform: string,
) {
  const install = parseDependencies([dependency])[0]?.install
  if (platform === 'darwin' && install?.brew)
    return {
      manager: 'Homebrew',
      command: 'brew',
      args: [
        'install',
        ...(install.brew.cask ? ['--cask'] : []),
        install.brew.package,
      ],
    }
  if (platform === 'win32' && install?.winget)
    return {
      manager: 'WinGet',
      command: 'winget',
      args: [
        'install',
        '--id',
        install.winget,
        '--exact',
        '--source',
        'winget',
        '--disable-interactivity',
      ],
    }
  return null
}
