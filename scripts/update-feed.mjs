import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { classifyRelease, installerFiles, releaseChannels } from './nightly.mjs'

export async function updateFeed(release, directory) {
  classifyRelease(release, release.reports)
  const entries = await readdir(directory, { withFileTypes: true })
  const namesWithSizes = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => ({
        name: entry.name,
        size: (await stat(resolve(directory, entry.name))).size,
      })),
  )
  const selected = installerFiles(
    release,
    namesWithSizes.filter((entry) => entry.size > 0).map((entry) => entry.name),
  )
  // Older updaters reject underscores; normalize only verified complete sets.
  for (const { source, name } of selected)
    if (source !== name)
      await rename(resolve(directory, source), resolve(directory, name))
  const names = selected.map(({ name }) => name)
  const assets = {}
  const hashAsset = async (name) => {
    const hash = createHash('sha512')
    let size = 0
    for await (const chunk of createReadStream(resolve(directory, name))) {
      hash.update(chunk)
      size += chunk.length
    }
    return { name, sha512: hash.digest('base64'), size }
  }
  for (const [platform, suffix] of [
    ['win32-x64', '-win-x64.exe'],
    ['linux-x64', '-linux-x64.AppImage'],
    ['linux-arm64', '-linux-arm64.AppImage'],
    ['darwin-arm64', '-mac-arm64.dmg'],
    ['darwin-x64', '-mac-x64.dmg'],
  ]) {
    // Debian and Flatpak packages are replaced manually, never through this feed.
    const matches = names.filter(
      (name) =>
        name.startsWith(`hibi-${release.version}-`) && name.endsWith(suffix),
    )
    if (matches.length === 0) continue
    // Existing macOS readers require both architectures in latest-mac.yml.
    if (
      platform.startsWith('darwin-') &&
      !['x64', 'arm64'].every((arch) =>
        names.includes(`hibi-${release.version}-mac-${arch}.zip`),
      )
    )
      continue
    assets[platform] = await hashAsset(matches[0])
    if (platform.startsWith('darwin-')) {
      const zipName = `hibi-${release.version}-mac-${platform.slice(7)}.zip`
      assets[platform].zip = await hashAsset(zipName)
    }
  }
  const manifest = {
    tag: release.tag,
    version: release.version,
    assets,
  }
  await writeFile(
    resolve(directory, 'feed.json'),
    JSON.stringify(manifest, null, 2),
  )
  // JSON is valid YAML. Each feed is pinned to this immutable release's packages.
  for (const [platform, name] of [
    ['win32-x64', 'latest.yml'],
    ['linux-x64', 'latest-linux.yml'],
    ['linux-arm64', 'latest-linux-arm64.yml'],
  ]) {
    const asset = assets[platform]
    if (!asset) {
      await rm(resolve(directory, name), { force: true })
      continue
    }
    await writeFile(
      resolve(directory, name),
      JSON.stringify(
        {
          version: release.version,
          files: [{ url: asset.name, sha512: asset.sha512, size: asset.size }],
          path: asset.name,
          sha512: asset.sha512,
        },
        null,
        2,
      ),
    )
  }
  if (assets['darwin-x64'] && assets['darwin-arm64']) {
    const macFiles = [assets['darwin-x64'].zip, assets['darwin-arm64'].zip].map(
      (asset) => ({ url: asset.name, sha512: asset.sha512, size: asset.size }),
    )
    await writeFile(
      resolve(directory, 'latest-mac.yml'),
      JSON.stringify(
        {
          version: release.version,
          files: macFiles,
          path: macFiles[0].url,
          sha512: macFiles[0].sha512,
        },
        null,
        2,
      ),
    )
  } else await rm(resolve(directory, 'latest-mac.yml'), { force: true })
  return manifest
}

export async function promoteFeeds(
  release,
  directory,
  repository,
  gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }),
  isAncestor = (previous, sha) => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', previous, sha], {
        stdio: 'ignore',
      })
      return true
    } catch {
      return false
    }
  },
) {
  classifyRelease(release, release.reports)
  const feed = JSON.parse(
    await readFile(resolve(directory, 'feed.json'), 'utf8'),
  )
  if (feed.tag !== release.tag || feed.version !== release.version)
    throw new Error('Channel feed must pin the published release')
  // Shipped clients pin every asset to one tag/version. Listings can advance
  // independently, while partial builds preserve the last complete feed.
  const complete = [
    'win32-x64',
    'linux-x64',
    'linux-arm64',
    'darwin-x64',
    'darwin-arm64',
  ].every((platform) => feed.assets[platform])
  const downloads = installerFiles(release, await readdir(directory)).map(
    ({ name }) =>
      `[${name}](https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(name)})`,
  )
  for (const channel of releaseChannels(release)) {
    const endpoint = `repos/${repository}/git/refs/tags/${channel}`
    let previous
    try {
      previous = JSON.parse(
        gh('api', `repos/${repository}/git/ref/tags/${channel}`),
      ).object.sha
    } catch {
      // The first publication creates the rolling tag.
    }
    if (channel === 'beta' && previous && !isAncestor(previous, release.sha)) {
      console.log('::notice::Preserving the newer beta feed.')
      continue
    }
    if (previous)
      gh(
        'api',
        '--method',
        'PATCH',
        endpoint,
        '-f',
        `sha=${release.sha}`,
        '-F',
        'force=true',
      )
    else
      gh(
        'api',
        '--method',
        'POST',
        `repos/${repository}/git/refs`,
        '-f',
        `ref=refs/tags/${channel}`,
        '-f',
        `sha=${release.sha}`,
      )
    const title =
      channel === 'beta' ? 'Beta (stable)' : 'Nightly (bleeding edge)'
    const policy =
      channel === 'beta'
        ? release.forceRelease === true
          ? 'This channel includes a forced beta. Check eligibility was overridden; see the versioned release for recorded results. Downloads are pinned to verified installers.'
          : 'This channel follows betas that passed all checks on every platform. Downloads are pinned to the versioned release.'
        : 'This channel follows the latest published build. Nightlies are bleeding edge. Back up your notes before installing.'
    const notes = [
      policy,
      ...(release.forceRelease === true
        ? [
            'This publication was explicitly forced; check eligibility was overridden.',
          ]
        : []),
      `Latest publication: [${release.tag}](https://github.com/${repository}/releases/tag/${encodeURIComponent(release.tag)}).`,
      ...(!complete
        ? [
            'Automatic updates remain on the last complete verified release, if one exists. This partial publication does not replace feed.json.',
          ]
        : []),
      ...(downloads.length
        ? ['Available verified installers:', ...downloads]
        : ['No verified installers are available for this publication.']),
    ].join('\n\n')
    const run = (...args) => gh('release', ...args, '--repo', repository)
    let exists = false
    try {
      run('view', channel)
      exists = true
    } catch {
      // Create the rolling prerelease without making it GitHub's latest release.
    }
    if (!exists)
      run(
        'create',
        channel,
        '--target',
        release.sha,
        '--title',
        title,
        '--notes',
        notes,
        '--prerelease',
        '--latest=false',
      )
    if (complete)
      run('upload', channel, resolve(directory, 'feed.json'), '--clobber')
    run(
      'edit',
      channel,
      '--target',
      release.sha,
      '--title',
      title,
      '--notes',
      notes,
      '--prerelease',
      '--latest=false',
    )
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const release = JSON.parse(await readFile('release.json', 'utf8'))
  if (process.argv[2] === 'publish')
    await promoteFeeds(release, 'installers', process.env.GITHUB_REPOSITORY)
  else await updateFeed(release, 'installers')
}
