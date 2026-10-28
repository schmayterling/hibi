import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const platforms = [
  'linux-x64',
  'linux-arm64',
  'windows-x64',
  'macos-arm64',
  'macos-x64',
]

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

const compareVersions = (left, right) => {
  const a = left.split('.').map(BigInt)
  const b = right.split('.').map(BigInt)
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  return 0
}

export function nightly(
  cwd = '.',
  date = new Date(),
  bump = 'patch',
  run = '0.0',
  { version: requestedVersion = '', forceRelease = false } = {},
) {
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  if (!['patch', 'minor'].includes(bump))
    throw new Error('Choose a patch or minor version bump')
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(run))
    throw new Error('Invalid workflow run identity')
  const sha = git('rev-parse', 'HEAD')
  const version = JSON.parse(
    readFileSync(resolve(cwd, 'package.json'), 'utf8'),
  ).version
  if (!semver.test(version))
    throw new Error('package.json must have a plain semver version')
  const latest = git('tag', '--list', 'v*')
    .split('\n')
    .filter((tag) => semver.test(tag.slice(1)))
    .sort((a, b) => compareVersions(b.slice(1), a.slice(1)))[0]
  let betaVersion = version
  if (latest) {
    const [major, minor, patch] = latest.slice(1).split('.').map(BigInt)
    const next =
      bump === 'minor'
        ? `${major}.${minor + 1n}.0`
        : `${major}.${minor}.${patch + 1n}`
    if (compareVersions(next, betaVersion) > 0) betaVersion = next
  }
  if (requestedVersion) {
    const match = /^(\d+\.\d+\.\d+)(\^)?$/.exec(requestedVersion)
    if (!match || match[0] !== requestedVersion || !semver.test(match[1]))
      throw new Error(
        'Manual version must be plain semver with an optional trailing ^',
      )
    requestedVersion = match[1]
    forceRelease = forceRelease || !!match[2]
    if (git('tag', '--list', `v${requestedVersion}`))
      throw new Error(`Release tag v${requestedVersion} already exists`)
    betaVersion = requestedVersion
  }
  const changed =
    !latest || git('rev-list', '--count', `${latest}..HEAD`) !== '0'
  const tags = git('tag', '--merged', 'HEAD')
    .split('\n')
    .filter(
      (tag) =>
        (semver.test(tag.slice(1)) && tag.startsWith('v')) ||
        /^nightly-(?:broken-)?\d{4}-\d{2}-\d{2}-[a-f0-9]{7}(?:-\d+-\d+)?$/.test(
          tag,
        ),
    )
  const nearest = (tags) =>
    tags.length
      ? git(
          'describe',
          '--tags',
          ...tags.flatMap((tag) => ['--match', tag]),
          '--abbrev=0',
          'HEAD',
        )
      : undefined
  const previous = nearest(tags)
  const previousRelease = nearest(tags.filter((tag) => tag.startsWith('v')))
  const commits = (previous) =>
    git('log', '--format=%H%x09%s', previous ? `${previous}..HEAD` : 'HEAD')
  const day = date.toISOString().slice(0, 10)
  return {
    sha,
    previous,
    previousRelease,
    releaseCommits: commits(previousRelease),
    betaVersion,
    requestedVersion,
    forceRelease,
    changed,
    nightlyTag: `nightly-${day}-${sha.slice(0, 7)}-${run.replace('.', '-')}`,
    nightlyVersion: `${betaVersion}-nightly.${day.replaceAll('-', '')}.g${sha.slice(0, 7)}.${run}`,
    commits: commits(previous),
  }
}

export function checksFromShards(platform, sha, reports) {
  if (
    !platforms.includes(platform) ||
    reports.length !== 4 ||
    [0, 1, 2, 3].some(
      (shard) =>
        reports.filter(
          (report) =>
            report.platform === platform &&
            report.sha === sha &&
            report.shard === shard,
        ).length !== 1,
    )
  )
    throw new Error(
      'Every release check shard must report the same platform and revision',
    )
  return reports.every((report) => report.checks === 'success')
    ? 'success'
    : 'failure'
}

export function decideRelease(release, shards) {
  if (shards.length !== platforms.length * 4)
    throw new Error('Every release check shard must report before deciding')
  const checks = platforms.map((platform) => ({
    platform,
    sha: release.sha,
    checks: checksFromShards(
      platform,
      release.sha,
      shards.filter((report) => report.platform === platform),
    ),
  }))
  const beta =
    release.forceRelease === true ||
    ((release.changed || !!release.requestedVersion) &&
      checks.every((report) => report.checks === 'success'))
  return {
    ...release,
    previous: beta ? release.previousRelease : release.previous,
    commits: beta ? release.releaseCommits : release.commits,
    channel: beta ? 'beta' : 'nightly',
    tag: beta ? `v${release.betaVersion}` : release.nightlyTag,
    version: beta ? release.betaVersion : release.nightlyVersion,
    checks,
    shards,
  }
}

export function classifyRelease(release, reports, shards = release.shards) {
  const decision = decideRelease(release, shards)
  if (
    ['channel', 'tag', 'version'].some((key) => release[key] !== decision[key])
  )
    throw new Error('Publication must match the checked release decision')
  if (
    reports.some((report) => !platforms.includes(report.platform)) ||
    platforms.some(
      (platform) =>
        reports.filter((report) => report.platform === platform).length > 1,
    )
  )
    throw new Error('Duplicate or unknown release platform report')
  if (reports.some((report) => report.sha !== release.sha))
    throw new Error('Cannot publish mismatched packages')
  if (
    reports.some(
      (report) =>
        report.version !== release.version ||
        report.tag !== release.tag ||
        report.channel !== release.channel ||
        report.checks !==
          decision.checks.find(
            (checked) => checked.platform === report.platform,
          ).checks,
    )
  )
    throw new Error('Packaged release does not match the checked decision')
  return {
    ...decision,
    reports: decision.checks.map(
      (checked) =>
        reports.find((report) => report.platform === checked.platform) ?? {
          ...checked,
          version: decision.version,
          tag: decision.tag,
          channel: decision.channel,
          build: 'missing',
          package: 'missing',
          verification: 'missing',
          result: 'missing',
        },
    ),
  }
}

export function releaseChannels(release) {
  return release.channel === 'beta' ? ['beta', 'nightly'] : ['nightly']
}

const installerSuffixes = {
  'linux-x64': ['linux-x64.AppImage', 'linux-x64.deb', 'linux-x64.flatpak'],
  'linux-arm64': [
    'linux-arm64.AppImage',
    'linux-arm64.deb',
    'linux-arm64.flatpak',
  ],
  'windows-x64': ['win-x64.exe'],
  'macos-arm64': ['mac-arm64.dmg', 'mac-arm64.zip'],
  'macos-x64': ['mac-x64.dmg', 'mac-x64.zip'],
}

// One allowlist for Actions artifacts, attachments, notes, and updater inputs.
export function installerFiles(release, names) {
  const checked = classifyRelease(release, release.reports)
  const entries = names.map((source) => {
    const prefix = `hibi-${release.version}-linux-`
    const alias =
      source.startsWith(prefix) &&
      /^(x86_64|amd64|aarch64)(\.(?:AppImage|deb|flatpak))$/.exec(
        source.slice(prefix.length),
      )
    const name = alias
      ? `${prefix}${alias[1] === 'aarch64' ? 'arm64' : 'x64'}${alias[2]}`
      : source
    return { source, name }
  })
  const result = []
  for (const report of checked.reports) {
    if (
      !['build', 'package', 'verification', 'result'].every(
        (key) => report[key] === 'success',
      )
    )
      continue
    const matches = installerSuffixes[report.platform].map((suffix) =>
      entries.filter(
        (entry) => entry.name === `hibi-${release.version}-${suffix}`,
      ),
    )
    if (matches.some((group) => group.length > 1))
      throw new Error('Ambiguous Linux packages or duplicate installer')
    if (matches.every((group) => group.length === 1))
      result.push(
        ...matches
          .flat()
          .map((entry) => ({ ...entry, platform: report.platform })),
      )
  }
  return result.sort(
    (left, right) => names.indexOf(left.source) - names.indexOf(right.source),
  )
}

function filesIn(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return []
  }
}

export function stageInstallers(release, directory, destination) {
  const names = filesIn(directory).filter(
    (name) => statSync(resolve(directory, name)).size > 0,
  )
  const assets = installerFiles(release, names)
  mkdirSync(destination, { recursive: true })
  for (const name of filesIn(destination))
    if (!assets.some((asset) => asset.name === name))
      rmSync(resolve(destination, name))
  for (const asset of assets)
    copyFileSync(
      resolve(directory, asset.source),
      resolve(destination, asset.name),
    )
  return assets
}

function releaseAssets(release, repository, checksums) {
  const url = `https://github.com/${repository}`
  const entries = checksums.trim()
    ? checksums
        .trim()
        .split('\n')
        .map((line) => {
          const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line)
          if (!match) throw new Error('Invalid nightly checksum entry')
          return { name: match[2].replace(/^\.\//, ''), hash: match[1] }
        })
    : []
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length)
    throw new Error('Duplicate nightly checksum entry')
  return installerFiles(
    release,
    entries.map((entry) => entry.name),
  ).map(({ source, name }) => ({
    name,
    hash: entries.find((entry) => entry.name === source).hash,
    url: `${url}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(name)}`,
  }))
}

export function nightlyWebhook(release, repository, checksums) {
  classifyRelease(release, release.reports)
  const beta = release.channel === 'beta'
  const role = '1550309423166267432'
  return {
    content: `<@&${role}> new ${release.channel} released: **${release.tag}**`,
    allowed_mentions: { parse: [], roles: [role] },
    embeds: [
      {
        title: '🦋',
        description: [
          `this ${release.channel} is built from [${release.sha.slice(0, 7)}](https://github.com/${repository}/commit/${release.sha}).`,
          '',
          '**download links**',
          ...(releaseAssets(release, repository, checksums).length
            ? []
            : ['no verified installers are available for this release.']),
          ...releaseAssets(release, repository, checksums).map(
            (asset) => `[${asset.name}](${asset.url})`,
          ),
        ].join('\n'),
        color: beta ? 9568176 : 9807270,
        footer: {
          text:
            release.forceRelease === true
              ? 'forced release: check eligibility was overridden. see release notes for actual checks and available verified installers.'
              : beta
                ? 'this beta passed all checks on every platform.'
                : 'back up your notes before installing. nightlies are bleeding edge and may be broken.',
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
  release = classifyRelease(release, release.reports)
  const url = `https://github.com/${repository}`
  const assets = releaseAssets(release, repository, checksums)
  const download = (label, suffix) => {
    const asset = assets.find(({ name }) => name.endsWith(suffix))
    return asset ? `[${label}](${asset.url})` : undefined
  }
  const commits = release.commits
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subject] = line.split('\t')
      const title = subject.join('\t').replace(/[\\`*_{}[\]<>]/g, '\\$&')
      return `- ${title} ([${sha.slice(0, 7)}](${url}/commit/${sha}))`
    })
  return [
    `this ${release.channel} was built from sha \`${release.sha.slice(0, 7)}\`.`,
    '',
    `**${release.channel}**`,
    ...(release.forceRelease === true
      ? [
          '',
          '**forced release: check eligibility was overridden; the recorded results below still apply.**',
        ]
      : []),
    '',
    ...(release.channel === 'nightly'
      ? ['**:warning: always back up before using a nightly!**', '']
      : []),
    ...(release.reports ?? []).map(
      (report) =>
        `- ${report.platform}: checks ${report.checks}; package ${report.package}; build ${report.build}; verification ${report.verification}; result ${report.result}; installers ${assets.some((asset) => installerSuffixes[report.platform].some((suffix) => asset.name.endsWith(`-${suffix}`))) ? 'available' : 'unavailable'}`,
    ),
    ...(release.runUrl ? ['', `[build and test logs](${release.runUrl})`] : []),
    '',
    [
      download('windows', '-win-x64.exe'),
      download('macOS (intel)', '-mac-x64.dmg'),
      download('macOS (apple silicon)', '-mac-arm64.dmg'),
      ...['x64', 'arm64'].flatMap((arch) =>
        ['AppImage', 'deb', 'flatpak'].map((format) =>
          download(`linux ${arch} (${format})`, `-linux-${arch}.${format}`),
        ),
      ),
    ]
      .filter(Boolean)
      .join(' • ') || 'no verified installers are available for this release.',
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
          `[full comparison](${url}/compare/${encodeURIComponent(release.previous)}...${release.channel === 'beta' ? encodeURIComponent(release.tag) : release.sha})`,
          '',
        ]
      : []),
  ].join('\n')
}

export function publishRelease(
  release,
  directory,
  repository,
  gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }),
) {
  classifyRelease(release, release.reports)
  const names = filesIn(directory)
  const selected = installerFiles(release, names)
  const installers = selected.map((asset) => asset.name)
  const available = new Set(selected.map((asset) => asset.platform))
  const metadata = [
    'SHA256SUMS.txt',
    'feed.json',
    ...(available.has('windows-x64') ? ['latest.yml'] : []),
    ...(available.has('linux-x64') ? ['latest-linux.yml'] : []),
    ...(available.has('linux-arm64') ? ['latest-linux-arm64.yml'] : []),
    ...(available.has('macos-x64') && available.has('macos-arm64')
      ? ['latest-mac.yml']
      : []),
  ].filter((name) => names.includes(name))
  const feed = JSON.parse(readFileSync(resolve(directory, 'feed.json'), 'utf8'))
  if (feed.tag !== release.tag || feed.version !== release.version)
    throw new Error('Published feed must match the checked release')
  const attachments = [...installers, ...metadata].map((name) =>
    resolve(directory, name),
  )
  attachments.push(resolve(directory, '..', 'release.json'))
  const notes = resolve(directory, '..', 'release-notes.md')
  writeFileSync(
    notes,
    releaseNotes(
      release,
      repository,
      readFileSync(resolve(directory, 'SHA256SUMS.txt'), 'utf8'),
    ),
  )
  let existing
  try {
    existing = JSON.parse(
      gh(
        'release',
        'view',
        release.tag,
        '--json',
        'isDraft,targetCommitish,assets',
      ),
    )
  } catch {
    // Creation still fails safely if lookup failed for a reason other than absence.
  }
  if (existing && !existing.isDraft) {
    console.log(
      `::notice::Release ${release.tag} already published; preserving its assets and feeds.`,
    )
    return { published: false, announce: false }
  }
  const prerelease = release.channel !== 'beta'
  if (existing) {
    if (existing.targetCommitish !== release.sha)
      throw new Error('Draft release must match the checked revision')
    const allowed = new Set([...installers, ...metadata, 'release.json'])
    for (const asset of existing.assets)
      if (!allowed.has(asset.name))
        gh('release', 'delete-asset', release.tag, '--yes', '--', asset.name)
  } else {
    gh(
      'release',
      'create',
      release.tag,
      '--target',
      release.sha,
      '--title',
      `hibi ${release.version} (${release.channel})`,
      '--notes-file',
      notes,
      '--draft',
      `--prerelease=${prerelease}`,
    )
  }
  // Only this checked draft is mutable; interrupted uploads can safely retry.
  gh('release', 'upload', release.tag, ...attachments, '--clobber')
  gh(
    'release',
    'edit',
    release.tag,
    '--notes-file',
    notes,
    '--draft=false',
    `--prerelease=${prerelease}`,
    `--latest=${!prerelease && installers.length > 0}`,
  )
  return { published: true, announce: true }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const readRelease = () => JSON.parse(readFileSync('release.json', 'utf8'))
  const readShards = () =>
    filesIn('check-shards')
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(readFileSync(resolve('check-shards', name), 'utf8')),
      )
  const saveRelease = (release, keys) => {
    writeFileSync('release.json', JSON.stringify(release, null, 2))
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      keys
        .map(
          (key) =>
            `${key}=${typeof release[key] === 'object' ? JSON.stringify(release[key]) : release[key]}\n`,
        )
        .join(''),
    )
  }
  if (process.argv[2] === 'prepare') {
    const run = `${process.env.GITHUB_RUN_NUMBER ?? '0'}.${process.env.GITHUB_RUN_ATTEMPT ?? '0'}`
    const bump =
      process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
        ? process.env.BUMP || 'patch'
        : 'patch'
    const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    const release = nightly('.', new Date(), bump, run, {
      version: manual ? process.env.RELEASE_VERSION || '' : '',
      forceRelease: manual && process.env.FORCE_RELEASE === 'true',
    })
    if (process.env.GITHUB_RUN_ID)
      release.runUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    saveRelease(release, ['sha'])
  } else if (process.argv[2] === 'decide') {
    saveRelease(decideRelease(readRelease(), readShards()), [
      'channel',
      'tag',
      'version',
      'checks',
    ])
  } else if (process.argv[2] === 'check-shards') {
    const [platform, sha, ...files] = process.argv.slice(3)
    const result = checksFromShards(
      platform,
      sha,
      files.map((file) => JSON.parse(readFileSync(file, 'utf8'))),
    )
    appendFileSync(process.env.GITHUB_OUTPUT, `result=${result}\n`)
  } else if (['classify', 'stage'].includes(process.argv[2])) {
    const stage = process.argv[2] === 'stage'
    const reports = filesIn('build-results')
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(readFileSync(resolve('build-results', name), 'utf8')),
      )
    const release = classifyRelease(
      readRelease(),
      reports,
      stage ? undefined : readShards(),
    )
    const assets = stageInstallers(
      release,
      stage ? 'release' : 'packages',
      stage ? 'verified-installers' : 'installers',
    )
    if (!stage) {
      writeFileSync(
        'installers/SHA256SUMS.txt',
        assets
          .map(
            ({ name }) =>
              `${createHash('sha256')
                .update(readFileSync(resolve('installers', name)))
                .digest('hex')}  ./${name}\n`,
          )
          .join(''),
      )
      saveRelease(release, ['channel', 'tag', 'version'])
    }
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `has_assets=${assets.length > 0}\n`,
    )
  } else if (process.argv[2] === 'publish') {
    const result = publishRelease(
      readRelease(),
      'installers',
      process.env.GITHUB_REPOSITORY,
    )
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(result)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    )
  } else if (process.argv[2] === 'notes') {
    process.stdout.write(
      releaseNotes(
        readRelease(),
        process.env.GITHUB_REPOSITORY,
        readFileSync('installers/SHA256SUMS.txt', 'utf8'),
      ),
    )
  } else if (process.argv[2] === 'notify') {
    if (process.env.NIGHTLIES_WEBHOOK_URL)
      await sendNightlyWebhook(
        process.env.NIGHTLIES_WEBHOOK_URL,
        nightlyWebhook(
          readRelease(),
          process.env.GITHUB_REPOSITORY,
          readFileSync('installers/SHA256SUMS.txt', 'utf8'),
        ),
      )
    else await sendNightlyWebhook('', {})
  } else {
    throw new Error(
      'Usage: node scripts/nightly.mjs prepare|decide|check-shards|stage|classify|publish|notes|notify',
    )
  }
}
