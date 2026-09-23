import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const platforms = [
  'linux-x64',
  'windows-x64',
  'macos-arm64',
  'macos-x64',
]

export function nightly(
  cwd = '.',
  date = new Date(),
  stableTag = '',
  run = '',
) {
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  const sha = git('rev-parse', 'HEAD')
  const tags = git('tag', '--merged', 'HEAD')
    .split('\n')
    .filter(
      (tag) =>
        /^v\d+\.\d+\.\d+$/.test(tag) ||
        (!stableTag && /^nightly-(?:broken-)?\d{4}-/.test(tag)),
    )
    .filter((tag) => tag !== stableTag)
  const previous = tags.length
    ? git(
        'describe',
        '--tags',
        ...tags.flatMap((tag) => ['--match', tag]),
        '--abbrev=0',
        'HEAD',
      )
    : undefined
  const day = date.toISOString().slice(0, 10)
  const version = JSON.parse(
    readFileSync(resolve(cwd, 'package.json'), 'utf8'),
  ).version
  const base = version.split('-')[0]
  if (
    stableTag &&
    (!/^v\d+\.\d+\.\d+$/.test(stableTag) || stableTag !== `v${version}`)
  )
    throw new Error(
      'Stable tags must match the non-prerelease package.json version',
    )
  if (run && !/^\d+\.\d+$/.test(run))
    throw new Error('Invalid workflow run identity')
  return {
    sha,
    previous,
    channel: stableTag ? 'stable' : 'nightly',
    tag:
      stableTag ||
      `nightly-${day}-${sha.slice(0, 7)}${run ? `-${run.replace('.', '-')}` : ''}`,
    version: stableTag
      ? version
      : `${base}-nightly.${day.replaceAll('-', '')}.g${sha.slice(0, 7)}${run ? `.${run}` : ''}`,
    commits: git(
      'log',
      '--format=%H%x09%s',
      previous ? `${previous}..HEAD` : 'HEAD',
    ),
  }
}

export function classifyRelease(release, reports) {
  if (
    reports.length !== platforms.length ||
    platforms.some(
      (platform) =>
        reports.filter((report) => report.platform === platform).length !== 1,
    )
  )
    throw new Error(
      'Every release platform must report its build, package and checks',
    )
  if (
    reports.some(
      (report) =>
        report.sha !== release.sha ||
        report.build !== 'success' ||
        report.package !== 'success',
    )
  )
    throw new Error('Cannot publish incomplete or mismatched packages')
  const green = reports.every((report) => report.checks === 'success')
  if (
    !['nightly', 'stable'].includes(release.channel) ||
    (release.channel === 'stable' && !green)
  )
    throw new Error(
      'Stable releases require the full required suite to pass on every platform',
    )
  const status =
    release.channel === 'stable'
      ? 'stable'
      : green
        ? 'nightly-green'
        : 'nightly-broken'
  return {
    ...release,
    status,
    reports,
    tag:
      status === 'nightly-broken'
        ? release.tag.replace(/^nightly-/, 'nightly-broken-')
        : release.tag,
  }
}

export function recommendedNightly(release, repository) {
  if (
    release.status !== 'nightly-green' ||
    classifyRelease(release, release.reports).status !== 'nightly-green'
  )
    throw new Error('Only fully checked green nightlies can be recommended')
  return {
    tag: release.tag,
    sha: release.sha,
    version: release.version,
    url: `https://github.com/${repository}/releases/tag/${release.tag}`,
  }
}

function releaseAssets(release, repository, checksums) {
  const url = `https://github.com/${repository}`
  return checksums
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line)
      if (!match) throw new Error('Invalid nightly checksum entry')
      const name = match[2].replace(/^\.\//, '')
      return {
        name,
        hash: match[1],
        url: `${url}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(name)}`,
      }
    })
}

export function nightlyWebhook(release, repository, checksums) {
  if (!['nightly-green', 'nightly-broken'].includes(release.status))
    throw new Error('Only classified nightlies can be announced')
  const green = release.status === 'nightly-green'
  const role = '1550309423166267432'
  return {
    content: `<@&${role}> new nightly released: **${release.tag}**`,
    allowed_mentions: { parse: [], roles: [role] },
    embeds: [
      {
        title: '🦋',
        description: [
          `this nightly is built from [${release.sha.slice(0, 7)}](https://github.com/${repository}/commit/${release.sha}).`,
          'as usual with all nightlies, please understand that you know what you are doing.',
          '',
          '**download links**',
          ...releaseAssets(release, repository, checksums).map(
            (asset) => `[${asset.name}](${asset.url})`,
          ),
        ].join('\n'),
        color: green ? 9568176 : 16748945,
        footer: {
          text: green
            ? '🟢 this nightly is tagged green and has passed all checks.'
            : '🔴 this nightly is tagged red.\n⚠️ this nightly has not passed all checks.',
        },
      },
    ],
    attachments: [],
  }
}

export async function sendNightlyWebhook(webhookUrl, payload) {
  if (!webhookUrl) {
    console.log(
      '::notice::NIGHTLIES_WEBHOOK_URL is unset; skipping announcement.',
    )
    return
  }
  let response
  try {
    const url = new URL(webhookUrl)
    url.searchParams.set('wait', 'true')
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new Error('Nightly webhook request failed')
  }
  if (!response.ok)
    throw new Error(`Nightly webhook failed: HTTP ${response.status}`)
}

export function releaseNotes(release, repository, checksums) {
  const url = `https://github.com/${repository}`
  const assets = releaseAssets(release, repository, checksums)
  const download = (label, suffix) => {
    const asset = assets.find(({ name }) => name.endsWith(suffix))
    if (!asset) throw new Error(`Missing nightly download: ${label}`)
    return `[${label}](${asset.url})`
  }
  download('macOS Intel ZIP', '-mac-x64.zip')
  download('macOS Apple Silicon ZIP', '-mac-arm64.zip')
  const commits = release.commits
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subject] = line.split('\t')
      const title = subject.join('\t').replace(/[\\`*_{}[\]<>]/g, '\\$&')
      return `- ${title} ([${sha.slice(0, 7)}](${url}/commit/${sha}))`
    })
  return [
    `this ${release.channel === 'stable' ? 'release' : 'nightly'} was built from sha \`${release.sha.slice(0, 7)}\`.`,
    '',
    `**${release.status}**`,
    '',
    ...(release.status === 'nightly-broken'
      ? [
          '> [!WARNING]',
          '> Required checks failed. This build is for debugging and dogfooding only. It is not the recommended nightly.',
          '',
        ]
      : []),
    ...(release.channel === 'nightly'
      ? ['**:warning: always back up before using a nightly!**', '']
      : []),
    ...(release.reports ?? []).map(
      (report) =>
        `- ${report.platform}: checks ${report.checks}; package ${report.package}`,
    ),
    ...(release.runUrl ? ['', `[build and test logs](${release.runUrl})`] : []),
    '',
    [
      download('windows', '-win-x64.exe'),
      download('macOS (intel)', '-mac-x64.dmg'),
      download('macOS (apple silicon)', '-mac-arm64.dmg'),
      download('linux (appImage)', '.AppImage'),
    ].join(' • '),
    '',
    '---',
    '',
    ...assets.flatMap((asset) => [
      `SHA256 ([${asset.name}](${asset.url})): \`${asset.hash}\``,
      '',
    ]),
    '## changes',
    '',
    ...commits,
    '',
    ...(release.previous
      ? [
          `[full comparison](${url}/compare/${encodeURIComponent(release.previous)}...${release.sha})`,
          '',
        ]
      : []),
  ].join('\n')
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv[2] === 'prepare') {
    const run = process.env.GITHUB_RUN_NUMBER
      ? `${process.env.GITHUB_RUN_NUMBER}.${process.env.GITHUB_RUN_ATTEMPT}`
      : ''
    const release = nightly('.', new Date(), process.env.STABLE_TAG ?? '', run)
    if (process.env.GITHUB_RUN_ID)
      release.runUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    writeFileSync('release.json', JSON.stringify(release, null, 2))
    const values = ['sha', 'tag', 'version', 'channel']
      .map((key) => `${key}=${release[key]}`)
      .join('\n')
    appendFileSync(process.env.GITHUB_OUTPUT, `${values}\n`)
  } else if (process.argv[2] === 'classify') {
    const release = classifyRelease(
      JSON.parse(readFileSync('release.json', 'utf8')),
      platforms.map((platform) =>
        JSON.parse(readFileSync(`installers/checks-${platform}.json`, 'utf8')),
      ),
    )
    writeFileSync('release.json', JSON.stringify(release, null, 2))
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `tag=${release.tag}\nstatus=${release.status}\n`,
    )
  } else if (process.argv[2] === 'notes') {
    const release = JSON.parse(readFileSync('release.json', 'utf8'))
    const checksums = readFileSync('installers/SHA256SUMS.txt', 'utf8')
    process.stdout.write(
      releaseNotes(release, process.env.GITHUB_REPOSITORY, checksums),
    )
  } else if (process.argv[2] === 'notify') {
    await sendNightlyWebhook(
      process.env.NIGHTLIES_WEBHOOK_URL,
      nightlyWebhook(
        JSON.parse(readFileSync('release.json', 'utf8')),
        process.env.GITHUB_REPOSITORY,
        readFileSync('installers/SHA256SUMS.txt', 'utf8'),
      ),
    )
  } else if (process.argv[2] === 'recommend') {
    const pointer = recommendedNightly(
      JSON.parse(readFileSync('release.json', 'utf8')),
      process.env.GITHUB_REPOSITORY,
    )
    writeFileSync('recommended-nightly.json', JSON.stringify(pointer, null, 2))
    writeFileSync(
      'recommended-notes.md',
      `# Latest recommended nightly\n\n[Download ${pointer.version}](${pointer.url}). All required checks passed on every release platform.\n\nSource commit: \`${pointer.sha}\`.\n\nThis rolling pointer changes only after a green nightly is published. Broken nightlies remain separate debug releases.\n`,
    )
  } else {
    throw new Error(
      'Usage: node scripts/nightly.mjs prepare|classify|notes|notify|recommend',
    )
  }
}
