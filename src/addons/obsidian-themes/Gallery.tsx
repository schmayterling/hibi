import { ChevronRight } from 'lucide-react'
import { Button } from '../ui'
import type { InstalledTheme, ThemeManifest, Vault } from './store'

type Entry = {
  value: string
  manifest: ThemeManifest
  source: string
}

/** Every theme Hibi knows for this vault, with its attribution. */
export function Gallery({
  vault,
  installed,
  chosen,
  disabled,
  onChoose,
}: {
  vault: Vault | null
  installed: readonly InstalledTheme[]
  chosen: string | null
  disabled: boolean
  onChoose: (value: string) => void
}) {
  const entries: Entry[] = [
    ...(vault?.themes ?? []).map((theme) => ({
      value:
        installed.find((item) => item.hash === theme.hash)?.id ??
        `vault:${theme.name}`,
      manifest: theme.manifest,
      source: 'In this vault',
    })),
    ...installed
      .filter(
        (item) =>
          item.source === 'folder' &&
          !vault?.themes.some((theme) => theme.hash === item.hash),
      )
      .map((item) => ({
        value: item.id,
        manifest: item.manifest,
        source: 'Added from a folder',
      })),
  ]
  if (!entries.length) return null
  return (
    <div className="settings-group">
      <h3>Themes</h3>
      <ul className="obsidian-theme-gallery" aria-label="Themes">
        {entries.map(({ value, manifest, source }) => (
          <li key={value}>
            <p>
              <strong>{manifest.name}</strong>
              {manifest.version ? ` ${manifest.version}` : ''}
              {value === chosen ? ' · Chosen' : ''}
            </p>
            <p>
              {[
                manifest.author ? `By ${manifest.author}` : 'Author not given',
                source,
              ].join(' · ')}
            </p>
            {manifest.authorUrl && <p>{manifest.authorUrl}</p>}
            {manifest.license ? (
              <details className="ui-disclosure">
                <summary>
                  <ChevronRight size={14} aria-hidden />
                  License
                </summary>
                <pre>{manifest.license}</pre>
              </details>
            ) : (
              <p>No license file. Check the theme's terms before sharing it.</p>
            )}
            <Button
              disabled={disabled || value === chosen}
              onClick={() => onChoose(value)}
            >
              Choose
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
