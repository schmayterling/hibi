import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import {
  checksFromShards,
  classifyRelease,
  decideRelease,
  nightly,
  nightlyWebhook,
  platforms,
  publishRelease,
  releaseChannels,
  releaseNotes,
  sendNightlyWebhook,
  stageInstallers,
} from '../scripts/nightly.mjs'

const sha = 'a'.repeat(40)
const prepared = {
  sha,
  betaVersion: '0.2.0',
  changed: true,
  nightlyTag: 'nightly-2026-10-25-aaaaaaa-12-1',
  nightlyVersion: '0.2.0-nightly.20261025.gaaaaaaa.12.1',
  previous: 'v0.1.0',
  previousRelease: 'v0.1.0',
  releaseCommits: `${sha}\tFix [editor] *cursor*`,
  commits: `${sha}\tFix [editor] *cursor*`,
  runUrl: 'https://github.com/owner/repo/actions/runs/123',
}
const shards = (sha) =>
  platforms.flatMap((platform) =>
    [0, 1, 2, 3].map((shard) => ({ platform, sha, shard, checks: 'success' })),
  )
const packages = (release) =>
  release.checks.map((report) => ({
    ...report,
    build: 'success',
    package: 'success',
    verification: 'success',
    result: 'success',
    channel: release.channel,
    tag: release.tag,
    version: release.version,
  }))
const checkedRelease = (reports = shards(sha), changed = true) => {
  const decided = decideRelease({ ...prepared, changed }, reports)
  return classifyRelease(decided, packages(decided))
}
function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'hibi-release-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim()
  git('init')
  git('config', 'user.name', 'Release test')
  git('config', 'user.email', 'release@example.invalid')
  writeFileSync(join(cwd, 'package.json'), '{"version":"0.2.0"}')
  git('add', 'package.json')
  git('commit', '-m', 'Initial app')
  return { cwd, git }
}
const date = new Date('2026-10-25T18:00:00Z')

test('version computation uses numeric latest tags, package floor, minor input and unchanged HEAD', (t) => {
  const { cwd, git } = repository(t)
  const first = nightly(cwd, date, 'patch', '12.1')
  assert.equal(first.betaVersion, '0.2.0')
  assert.equal(first.changed, true)
  assert.equal(first.previous, undefined)
  assert.match(first.commits, /Initial app/)
  assert.equal(
    first.nightlyTag,
    `nightly-2026-10-25-${first.sha.slice(0, 7)}-12-1`,
  )
  assert.equal(
    first.nightlyVersion,
    `0.2.0-nightly.20261025.g${first.sha.slice(0, 7)}.12.1`,
  )
  assert.notEqual(
    nightly(cwd, date, 'patch', '12.2').nightlyTag,
    first.nightlyTag,
  )
  git('tag', 'v0.1.9')
  assert.equal(
    nightly(cwd, date).betaVersion,
    '0.2.0',
    'package version is a floor',
  )
  assert.equal(nightly(cwd, date).changed, false)
  for (const tag of [
    'v0.2.9',
    'v0.2.10',
    'v0.2.2',
    'v99.0.0-beta.1',
    'v01.0.0',
    'beta',
    'nightly',
    'nightly-green',
  ])
    git('tag', tag)
  const unchanged = nightly(cwd, date)
  assert.equal(unchanged.betaVersion, '0.2.11')
  assert.equal(unchanged.changed, false)
  assert.equal(decideRelease(unchanged, shards(first.sha)).channel, 'nightly')
  assert.equal(nightly(cwd, new Date('2026-10-26T18:00:00Z')).sha, first.sha)
  git('commit', '--allow-empty', '-m', 'Fix editor')
  assert.equal(nightly(cwd, date).changed, true)
  assert.equal(nightly(cwd, date, 'minor').betaVersion, '0.3.0')
  const next = nightly(cwd, date)
  git('tag', next.nightlyTag)
  git('commit', '--allow-empty', '-m', 'Fix selection')
  const following = nightly(cwd, date)
  assert.equal(
    following.previous,
    next.nightlyTag,
    'rolling feeds are excluded from changelogs',
  )
  assert.match(following.commits, /Fix selection/)
  assert.doesNotMatch(following.commits, /Initial app/)
  writeFileSync(join(cwd, 'package.json'), '{"version":"0.5.2"}')
  assert.equal(nightly(cwd, date).betaVersion, '0.5.2')
  assert.equal(nightly(cwd, date, 'minor').betaVersion, '0.5.2')
  assert.throws(() => nightly(cwd, date, 'major'), /patch or minor/)
  assert.throws(() => nightly(cwd, date, 'patch', '01.1'), /run identity/)
  writeFileSync(join(cwd, 'package.json'), '{"version":"0.5.2-beta.1"}')
  assert.throws(() => nightly(cwd, date), /plain semver/)
})

test('versioned release notes include changes since the previous versioned tag', async (t) => {
  const { cwd, git } = repository(t)
  git('tag', 'v0.2.1')
  git('commit', '--allow-empty', '-m', 'first release change')
  const earlier = nightly(cwd, date, 'patch', '12.1')
  git('tag', earlier.nightlyTag)
  git('commit', '--allow-empty', '-m', 'second release change')
  git('tag', 'nightly')
  git('tag', 'beta')

  for (const [name, options] of [
    ['normal', {}],
    ['forced', { forceRelease: true }],
    ['forced version', { version: '0.2.3^' }],
  ])
    await t.test(name, () => {
      const prepared = JSON.parse(
        JSON.stringify(nightly(cwd, date, 'patch', '12.2', options)),
      )
      const reports = shards(prepared.sha)
      if (name !== 'normal') reports[0].checks = 'failure'
      const release = classifyRelease(decideRelease(prepared, reports), [])
      assert.equal(release.channel, 'beta')
      assert.equal(release.previous, 'v0.2.1')
      assert.match(release.commits, /first release change/)
      assert.match(release.commits, /second release change/)
      assert.doesNotMatch(release.commits, /Initial app/)
      const notes = releaseNotes(release, 'owner/repo', '')
      assert.ok(notes.includes(`/compare/v0.2.1...${release.tag}`))
      assert.match(notes, /first release change/)
    })

  const prepared = nightly(cwd, date, 'patch', '12.2')
  const reports = shards(prepared.sha)
  reports[0].checks = 'failure'
  const release = classifyRelease(decideRelease(prepared, reports), [])
  assert.equal(release.channel, 'nightly')
  assert.equal(release.previous, earlier.nightlyTag)
  assert.match(release.commits, /second release change/)
  assert.doesNotMatch(release.commits, /first release change/)
  assert.ok(
    releaseNotes(release, 'owner/repo', '').includes(
      `/compare/${earlier.nightlyTag}...${release.sha}`,
    ),
  )
})

test('a first versioned release includes history before any nightly', (t) => {
  const { cwd, git } = repository(t)
  git('tag', nightly(cwd, date).nightlyTag)
  git('commit', '--allow-empty', '-m', 'first release change')
  const prepared = JSON.parse(JSON.stringify(nightly(cwd, date)))
  const release = classifyRelease(
    decideRelease(prepared, shards(prepared.sha)),
    [],
  )
  assert.equal(release.previous, undefined)
  assert.match(release.commits, /Initial app/)
  assert.match(release.commits, /first release change/)
  assert.doesNotMatch(
    releaseNotes(release, 'owner/repo', ''),
    /full comparison/,
  )
})

test('every shard must pass for beta; other complete runs publish nightlies without relabeling packages', () => {
  const beta = checkedRelease()
  assert.equal(beta.channel, 'beta')
  assert.equal(beta.tag, 'v0.2.0')
  assert.equal(beta.version, '0.2.0')
  assert.deepEqual(releaseChannels(beta), ['beta', 'nightly'])
  for (const checks of ['failure', 'cancelled', 'skipped', undefined]) {
    for (let i = 0; i < platforms.length * 4; i++) {
      const reports = shards(sha)
      reports[i].checks = checks
      const release = checkedRelease(reports)
      assert.equal(release.channel, 'nightly')
      assert.equal(release.tag, prepared.nightlyTag)
      assert.equal(release.version, prepared.nightlyVersion)
      assert.deepEqual(releaseChannels(release), ['nightly'])
    }
  }
  assert.equal(checkedRelease(shards(sha), false).channel, 'nightly')
})

test('check provenance fails closed while missing build reports remain visible', () => {
  const reports = shards(sha)
  for (const invalid of [
    reports.slice(1),
    [...reports, reports[0]],
    [reports[1], ...reports.slice(1)],
    [{ ...reports[0], sha: 'b'.repeat(40) }, ...reports.slice(1)],
    [{ ...reports[0], platform: 'other' }, ...reports.slice(1)],
  ])
    assert.throws(
      () => decideRelease(prepared, invalid),
      /Every release check shard/,
    )
  const beta = decideRelease(prepared, reports)
  const built = packages(beta)
  for (const key of ['channel', 'tag', 'version'])
    assert.throws(
      () => classifyRelease({ ...beta, [key]: 'mismatch' }, built),
      /checked release decision/,
    )
  assert.equal(
    classifyRelease(beta, built.slice(1)).reports[0].result,
    'missing',
  )
  assert.throws(
    () => classifyRelease(beta, [built[1], ...built.slice(1)]),
    /release platform/,
  )
  for (const stage of ['build', 'package', 'verification', 'result']) {
    for (const outcome of ['failure', 'cancelled', 'skipped', undefined]) {
      const classified = classifyRelease(beta, [
        { ...built[0], [stage]: outcome },
        ...built.slice(1),
      ])
      assert.equal(classified.reports[0][stage], outcome)
    }
  }
  for (const [key, value] of [
    ['sha', 'b'.repeat(40)],
    ['version', '0.2.1'],
    ['tag', prepared.nightlyTag],
    ['channel', 'nightly'],
    ['checks', 'failure'],
  ])
    assert.throws(
      () =>
        classifyRelease(beta, [
          { ...built[0], [key]: value },
          ...built.slice(1),
        ]),
      /mismatched packages|checked decision/,
    )
  const failed = [{ ...reports[0], checks: 'failure' }, ...reports.slice(1)]
  assert.throws(
    () => classifyRelease(beta, built, failed),
    /checked release decision/,
  )
  const nightly = decideRelease(prepared, failed)
  assert.throws(
    () => classifyRelease(nightly, packages(nightly), reports),
    /checked release decision/,
  )
  const platformReports = reports.filter(
    (report) => report.platform === 'macos-x64',
  )
  assert.equal(checksFromShards('macos-x64', sha, platformReports), 'success')
  assert.throws(
    () => checksFromShards('macos-x64', sha, platformReports.slice(1)),
    /Every release check shard/,
  )
})

const downloads = (version) =>
  [
    'win-x64.exe',
    'mac-x64.dmg',
    'mac-arm64.dmg',
    'mac-x64.zip',
    'mac-arm64.zip',
    ...['x64', 'arm64'].flatMap((arch) =>
      ['AppImage', 'deb', 'flatpak'].map((ext) => `linux-${arch}.${ext}`),
    ),
  ].map((suffix) => `hibi-${version}-${suffix}`)
const checksums = (release) =>
  downloads(release.version)
    .map((name) => `${'a'.repeat(64)}  ./${name}`)
    .join('\n')

test('release notes and webhook announce both channels with check results, logs and direct downloads', () => {
  const failed = shards(sha)
  failed[0].checks = 'failure'
  for (const release of [
    checkedRelease(),
    checkedRelease(failed),
    checkedRelease(shards(sha), false),
  ]) {
    const notes = releaseNotes(release, 'owner/repo', checksums(release))
    assert.match(notes, /linux-x64: checks (success|failure); package success/)
    assert.ok(notes.includes(`[build and test logs](${prepared.runUrl})`))
    assert.doesNotMatch(notes, /\b(green|red|broken)\b/)
    assert.match(notes, /Fix \\\[editor\\\] \\\*cursor\\\*/)
    assert.ok(
      notes.includes(
        `/compare/v0.1.0...${release.channel === 'beta' ? release.tag : sha}`,
      ),
    )
    assert.equal(
      notes.match(/^SHA256 /gm).length,
      downloads(release.version).length,
    )
    const payload = nightlyWebhook(release, 'owner/repo', checksums(release))
    const beta = release.channel === 'beta'
    assert.equal(
      payload.content,
      '<@&1550309423166267432> new ' +
        release.channel +
        ' released: **' +
        release.tag +
        '**',
    )
    assert.deepEqual(payload.allowed_mentions, {
      parse: [],
      roles: ['1550309423166267432'],
    })
    assert.deepEqual(payload.attachments, [])
    const [embed] = payload.embeds
    assert.equal(embed.title, '🦋')
    assert.equal(embed.color, beta ? 9568176 : 9807270)
    assert.equal(
      embed.footer.text,
      beta
        ? 'this beta passed all checks on every platform.'
        : 'back up your notes before installing. nightlies are bleeding edge and may be broken.',
    )
    assert.ok(embed.description.includes(`/commit/${sha}`))
    assert.deepEqual(
      embed.description.split('**download links**\n')[1].split('\n'),
      downloads(release.version).map(
        (name) =>
          '[' +
          name +
          '](https://github.com/owner/repo/releases/download/' +
          release.tag +
          '/' +
          encodeURIComponent(name) +
          ')',
      ),
    )
    assert.ok(embed.description.length <= 4096)
    assert.throws(
      () => releaseNotes(release, 'owner/repo', 'invalid'),
      /checksum/,
    )
    assert.doesNotMatch(
      releaseNotes(
        release,
        'owner/repo',
        checksums(release).split('\n').slice(1).join('\n'),
      ),
      /-win-x64\.exe/,
    )
    assert.throws(
      () =>
        releaseNotes(
          release,
          'owner/repo',
          `${checksums(release)}\n${checksums(release)}`,
        ),
      /Duplicate nightly checksum/,
    )
  }
})

test('prepare, decide and classify CLI preserve the packaged identity and scheduled patch policy', (t) => {
  const { cwd, git } = repository(t)
  git('tag', 'v0.2.4')
  git('commit', '--allow-empty', '-m', 'Fix editor')
  const output = join(cwd, 'output')
  const cli = (command, env = {}) =>
    execFileSync(process.execPath, [resolve('scripts/nightly.mjs'), command], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        GITHUB_EVENT_NAME: 'schedule',
        BUMP: 'minor',
        GITHUB_RUN_NUMBER: '99',
        GITHUB_RUN_ATTEMPT: '2',
        ...env,
      },
    })
  cli('prepare', { RELEASE_VERSION: '0.8.0^', FORCE_RELEASE: 'true' })
  const readRelease = () =>
    JSON.parse(readFileSync(join(cwd, 'release.json'), 'utf8'))
  assert.equal(
    readRelease().betaVersion,
    '0.2.5',
    'scheduled runs ignore minor input',
  )
  assert.equal(
    readRelease().forceRelease,
    false,
    'scheduled runs ignore force and version inputs',
  )
  cli('prepare', {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    RELEASE_VERSION: '0.8.0',
    FORCE_RELEASE: 'false',
  })
  assert.equal(
    readRelease().forceRelease,
    false,
    'false boolean string never enables forcing',
  )
  assert.equal(readRelease().betaVersion, '0.8.0')
  cli('prepare', { GITHUB_EVENT_NAME: 'workflow_dispatch' })
  assert.equal(readRelease().betaVersion, '0.3.0')
  const revision = readRelease().sha
  mkdirSync(join(cwd, 'check-shards'))
  for (const report of shards(revision))
    writeFileSync(
      join(cwd, 'check-shards', `${report.platform}-${report.shard}.json`),
      JSON.stringify(report),
    )
  cli('decide')
  const decided = readRelease()
  assert.equal(decided.version, '0.3.0')
  for (const entry of ['channel=beta', 'version=0.3.0', 'tag=v0.3.0'])
    assert.ok(readFileSync(output, 'utf8').includes(entry))
  mkdirSync(join(cwd, 'build-results'))
  mkdirSync(join(cwd, 'packages'))
  for (const name of downloads(decided.version))
    writeFileSync(join(cwd, 'packages', name), 'verified installer')
  for (const report of packages(decided))
    writeFileSync(
      join(cwd, 'build-results', `checks-${report.platform}.json`),
      JSON.stringify(report),
    )
  cli('classify')
  assert.equal(readRelease().version, decided.version)
  const changedReport = { ...shards(revision)[0], checks: 'failure' }
  writeFileSync(
    join(cwd, 'check-shards', `${changedReport.platform}-0.json`),
    JSON.stringify(changedReport),
  )
  assert.throws(() => cli('classify'), /checked release decision/)
})

test('webhook confirms delivery, skips unset secrets and keeps secrets out of failures', async (t) => {
  const requests = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
  }))
  await sendNightlyWebhook('', {})
  assert.equal(requests.mock.callCount(), 0)
  const webhookUrl = 'https://discord.com/api/webhooks/123/secret?thread_id=456'
  const payload = { content: 'release announcement' }
  await sendNightlyWebhook(webhookUrl, payload)
  const [url, options] = requests.mock.calls[0].arguments
  assert.equal(url.searchParams.get('wait'), 'true')
  assert.equal(url.searchParams.get('thread_id'), '456')
  assert.equal(options.method, 'POST')
  assert.equal(options.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(options.body), payload)
  assert.ok(options.signal instanceof AbortSignal)
  requests.mock.mockImplementation(async () => ({ ok: false, status: 429 }))
  await assert.rejects(sendNightlyWebhook(webhookUrl, payload), {
    message: 'Nightly webhook failed: HTTP 429',
  })
  requests.mock.mockImplementation(async () => {
    throw new Error(webhookUrl)
  })
  for (const url of [webhookUrl, 'invalid secret url'])
    await assert.rejects(sendNightlyWebhook(url, payload), {
      message: 'Nightly webhook request failed',
    })
})

test('workflow decides before signing, verifies before publishing and preserves frozen forwards', () => {
  const expression = (value) => ['$', '{{ ', value, ' }}'].join('')
  const source = readFileSync('.github/workflows/nightly.yml', 'utf8')
  const workflow = parse(source)
  assert.equal(workflow.on.push, undefined)
  assert.equal(workflow.on.workflow_dispatch.inputs.bump.default, 'patch')
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.bump.options, [
    'patch',
    'minor',
  ])
  assert.equal(workflow.concurrency.group, 'releases')
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
  assert.equal(workflow.jobs.prepare.if, "github.ref == 'refs/heads/main'")
  assert.deepEqual(workflow.jobs.decide.needs, ['prepare', 'checks'])
  assert.deepEqual(workflow.jobs.build.needs, ['prepare', 'decide'])
  assert.deepEqual(workflow.jobs.publish.needs, ['prepare', 'decide', 'build'])
  assert.equal(
    workflow.jobs.publish.if,
    expression(
      "!cancelled() && needs.prepare.result == 'success' && needs.decide.result == 'success'",
    ),
  )
  assert.equal(workflow.jobs.build['continue-on-error'], true)
  assert.deepEqual(Object.keys(workflow.jobs.decide.outputs).sort(), [
    'channel',
    'checks',
    'tag',
    'version',
  ])
  assert.doesNotMatch(
    source,
    /nightly-green|recommended-nightly|update\.json|STABLE_TAG|nightly-broken/,
  )
  const checkJob = workflow.jobs.checks
  assert.deepEqual(checkJob.strategy.matrix.shard, [0, 1, 2, 3])
  assert.deepEqual(
    checkJob.strategy.matrix.include.map((item) => item.platform).sort(),
    [...platforms].sort(),
  )
  const checks = checkJob.steps.find((step) => step.id === 'ci')
  assert.equal(workflow.on.workflow_dispatch.inputs.version.type, 'string')
  assert.equal(
    workflow.on.workflow_dispatch.inputs.force_release.type,
    'boolean',
  )
  assert.equal(
    workflow.on.workflow_dispatch.inputs.force_release.default,
    false,
  )
  assert.equal(checks['continue-on-error'], true)
  assert.ok(checks['timeout-minutes'] < checkJob['timeout-minutes'])
  assert.equal(checks.with.clean, true)
  assert.equal(checks.with.shard, `${expression('matrix.shard')}/4`)
  const reportUpload = checkJob.steps.at(-1)
  assert.equal(
    reportUpload.with.path,
    'checks-' +
      expression('matrix.platform') +
      '-' +
      expression('matrix.shard') +
      '.json',
  )
  const steps = workflow.jobs.build.steps
  assert.deepEqual(
    workflow.jobs.build.strategy.matrix.include
      .map((item) => item.platform)
      .sort(),
    [...platforms].sort(),
  )
  assert.equal(steps.find((step) => step.id === 'compile').run, 'npm run build')
  const packageStep = steps.find((step) => step.id === 'package')
  assert.equal(
    packageStep.env.RELEASE_VERSION,
    expression('needs.decide.outputs.version'),
  )
  assert.match(packageStep.run, /extraMetadata.version="\$RELEASE_VERSION"/)
  const credentials = steps.find(
    (step) => step.name === 'Install macOS signing credentials',
  )
  for (const command of [
    'security import',
    'security set-key-partition-list',
    'base64 --decode',
    'openssl pkey',
    'CSC_KEYCHAIN=',
    'APPLE_API_KEY=',
  ])
    assert.ok(credentials.run.includes(command))
  const verifyMac = steps.find(
    (step) => step.name === 'Verify signed macOS installers',
  )
  for (const command of [
    'codesign --verify',
    'spctl --assess',
    'bash scripts/validate-stapled-ticket.sh "$app"',
  ])
    assert.ok(verifyMac.run.includes(command))
  const builder = parse(readFileSync('electron-builder.yml', 'utf8'))
  assert.equal(builder.mac.forceCodeSigning, true)
  assert.equal(builder.mac.notarize, true)
  const publish = workflow.jobs.publish.steps
  assert.ok(
    publish.some((step) => step.with?.pattern === 'checks-*'),
    'publication rereads shard reports',
  )
  assert.ok(
    publish.findIndex((step) => step.id === 'classify') <
      publish.findIndex((step) => step.id === 'publish'),
  )
  const immutable = publish.find((step) => step.id === 'publish')
  assert.equal(immutable.run, 'node scripts/nightly.mjs publish')
  assert.doesNotMatch(source, /sha256sum|gh release upload/)
  const feeds = publish.find((step) => step.id === 'feeds')
  assert.equal(feeds.if, "steps.publish.outputs.published == 'true'")
  assert.equal(feeds.run, 'node scripts/update-feed.mjs publish')
  const announcement = publish.find(
    (step) => step.name === 'Announce release on Discord',
  )
  assert.equal(
    announcement.if,
    "steps.publish.outputs.announce == 'true' && steps.feeds.outcome == 'success'",
  )
  assert.equal(
    announcement.env.NIGHTLIES_WEBHOOK_URL,
    expression('secrets.NIGHTLIES_WEBHOOK_URL'),
  )
  assert.ok(publish.indexOf(feeds) < publish.indexOf(announcement))
})

test('manual versions and force override check eligibility without putting carets in tags', (t) => {
  const { cwd, git } = repository(t)
  const failed = shards(git('rev-parse', 'HEAD'))
  failed[0].checks = 'failure'
  for (const options of [
    { version: '0.8.0^' },
    { version: '0.8.0', forceRelease: true },
    { forceRelease: true },
  ]) {
    const release = nightly(cwd, date, 'patch', '12.1', options)
    const decided = decideRelease(release, failed)
    assert.equal(decided.channel, 'beta')
    assert.equal(decided.forceRelease, true)
    assert.equal(decided.checks[0].checks, 'failure')
    assert.equal(decided.tag, options.version ? 'v0.8.0' : 'v0.2.0')
    assert.ok(!decided.tag.includes('^'))
    assert.deepEqual(releaseChannels(decided), ['beta', 'nightly'])
  }
  const requested = nightly(cwd, date, 'patch', '12.1', { version: '0.8.0' })
  assert.equal(decideRelease(requested, failed).channel, 'nightly')
  assert.equal(decideRelease(requested, shards(requested.sha)).tag, 'v0.8.0')
  for (const version of [
    '0.8.0^^',
    'v0.8.0',
    '0.08.0',
    '0.8.0-beta.1',
    '0.8.0^/bad',
    '0.8.0\n^',
  ])
    assert.throws(
      () => nightly(cwd, date, 'patch', '12.1', { version }),
      /version/,
    )
  git('tag', 'v0.8.0')
  assert.throws(
    () => nightly(cwd, date, 'patch', '12.1', { version: '0.8.0^' }),
    /already exists/,
  )
})

test('missing and failed builds remain reportable while provenance and duplicates stay strict', () => {
  const decided = decideRelease(
    { ...prepared, forceRelease: true },
    shards(sha),
  )
  const built = packages(decided).map((report) => ({
    ...report,
    result: 'success',
    verification: 'success',
  }))
  for (const field of ['build', 'package', 'verification', 'result']) {
    const reports = [{ ...built[0], [field]: 'failure' }, ...built.slice(1)]
    const classified = classifyRelease(decided, reports)
    assert.equal(classified.reports[0][field], 'failure')
  }
  const missing = classifyRelease(decided, built.slice(1))
  assert.equal(missing.reports[0].result, 'missing')
  assert.equal(classifyRelease(decided, []).reports.length, platforms.length)
  assert.throws(
    () => classifyRelease(decided, [built[0], built[0]]),
    /platform/,
  )
  assert.throws(
    () =>
      classifyRelease(decided, [
        { ...built[0], sha: 'b'.repeat(40), build: 'failure' },
      ]),
    /mismatched/,
  )
})

test('forced notes and butterfly footer disclose failed checks and zero available installers', () => {
  const reports = shards(sha)
  reports[0].checks = 'failure'
  const decided = decideRelease({ ...prepared, forceRelease: true }, reports)
  const release = classifyRelease(decided, [])
  const notes = releaseNotes(release, 'owner/repo', '')
  assert.match(notes, /forced/i)
  assert.match(notes, /checks failure/)
  assert.match(notes, /no verified installers/i)
  const [embed] = nightlyWebhook(release, 'owner/repo', '').embeds
  assert.equal(embed.title, '🦋')
  assert.equal(embed.color, 9568176)
  assert.match(embed.footer.text, /forced/i)
  assert.doesNotMatch(embed.footer.text, /passed all checks/)
  assert.doesNotMatch(embed.description, /releases\/download/)
})

test('one shared asset filter excludes failed verification, partial sets and unrelated files', (t) => {
  const { cwd } = repository(t)
  const released = checkedRelease()
  const source = join(cwd, 'packages')
  const destination = join(cwd, 'verified')
  mkdirSync(source)
  for (const name of downloads(released.version))
    writeFileSync(join(source, name), 'installer')
  writeFileSync(join(source, 'unverified.exe'), 'untrusted')
  released.reports.find(
    (report) => report.platform === 'macos-x64',
  ).verification = 'failure'
  released.reports.find((report) => report.platform === 'linux-arm64').build =
    'failure'
  rmSync(join(source, 'hibi-0.2.0-linux-x64.deb'))
  const selected = stageInstallers(released, source, destination)
  assert.deepEqual(selected.map((asset) => asset.platform).sort(), [
    'macos-arm64',
    'macos-arm64',
    'windows-x64',
  ])
  assert.deepEqual(
    readdirSync(destination).sort(),
    selected.map((asset) => asset.name).sort(),
  )
  const sums = selected
    .map((asset) => `${'a'.repeat(64)}  ./${asset.name}`)
    .join('\n')
  for (const text of [
    releaseNotes(released, 'owner/repo', sums),
    nightlyWebhook(released, 'owner/repo', sums).embeds[0].description,
  ]) {
    assert.doesNotMatch(text, /hibi-0\.2\.0-(mac-x64|linux-)|unverified\.exe/)
    assert.match(text, /hibi-0\.2\.0-win-x64\.exe/)
  }
})

test('failed-step reports and zero-build CLI publish metadata without glob errors', (t) => {
  const { cwd } = repository(t)
  const workflow = parse(readFileSync('.github/workflows/nightly.yml', 'utf8'))
  const record = workflow.jobs.build.steps.find((step) => step.id === 'results')
  const reportUpload = workflow.jobs.build.steps.find((step) =>
    step.with?.name?.startsWith('build-result-'),
  )
  assert.equal(record.if, 'always()')
  assert.match(reportUpload.if, /always\(\)/)
  const finalReport = workflow.jobs.build.steps.find(
    (step) => step.name === 'Record final platform outcome',
  )
  const installerUpload = workflow.jobs.build.steps.find(
    (step) => step.with?.path === 'verified-installers/*',
  )
  assert.ok(
    workflow.jobs.build.steps.indexOf(finalReport) >
      workflow.jobs.build.steps.indexOf(installerUpload),
  )
  assert.match(finalReport.if, /always\(\)/)
  const reports = shards(sha)
  reports[0].checks = 'failure'
  const released = decideRelease({ ...prepared, forceRelease: true }, reports)
  writeFileSync(join(cwd, 'release.json'), JSON.stringify(released))
  mkdirSync(join(cwd, 'check-shards'))
  for (const report of reports)
    writeFileSync(
      join(cwd, 'check-shards', `${report.platform}-${report.shard}.json`),
      JSON.stringify(report),
    )
  execFileSync('bash', ['-e', '-o', 'pipefail', '-c', record.run], {
    cwd,
    env: {
      ...process.env,
      PLATFORM: 'linux-x64',
      SHA: sha,
      BUILD_RESULT: 'failure',
      CHECKS_RESULT: '',
      EXPECTED_CHECKS: JSON.stringify(released.checks),
      PACKAGE_RESULT: 'skipped',
      VERSION: released.version,
      TAG: released.tag,
      CHANNEL: released.channel,
      RESULT: 'failure',
      INSPECT_LINUX: 'skipped',
      LAUNCH_LINUX: 'skipped',
      VERIFY_MAC: 'skipped',
    },
  })
  const report = JSON.parse(
    readFileSync(join(cwd, 'build-results/checks-linux-x64.json'), 'utf8'),
  )
  assert.equal(report.build, 'failure')
  assert.equal(report.checks, 'failure')
  assert.equal(report.verification, 'failure')
  const env = {
    ...process.env,
    GITHUB_OUTPUT: join(cwd, 'output'),
    GITHUB_REPOSITORY: 'owner/repo',
  }
  const script = resolve('scripts/nightly.mjs')
  const cli = (command) =>
    execFileSync(process.execPath, [script, command], { cwd, env })
  cli('stage')
  assert.deepEqual(readdirSync(join(cwd, 'verified-installers')), [])
  cli('classify')
  rmSync(join(cwd, 'build-results'), { recursive: true })
  cli('classify')
  const classified = JSON.parse(readFileSync(join(cwd, 'release.json'), 'utf8'))
  assert.ok(classified.reports.every((report) => report.result === 'missing'))
  execFileSync(process.execPath, [resolve('scripts/update-feed.mjs')], {
    cwd,
    env,
  })
  assert.deepEqual(
    JSON.parse(readFileSync(join(cwd, 'installers/feed.json'), 'utf8')).assets,
    {},
  )
  assert.equal(readFileSync(join(cwd, 'installers/SHA256SUMS.txt'), 'utf8'), '')
  const notes = cli('notes').toString()
  assert.match(notes, /forced release/)
  assert.doesNotMatch(notes, /releases\/download/)
  // Stub the child Node process itself: Windows cannot execute a shell-script
  // `gh`, and its PATH separator is not a colon.
  const stub = `
    import childProcess from 'node:child_process'
    import { appendFileSync } from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    const execute = childProcess.execFileSync
    childProcess.execFileSync = (command, args, ...options) => {
      if (command !== 'gh') return execute(command, args, ...options)
      appendFileSync(process.env.GH_CALLS, args.join(' ') + '\\n')
      if (args[1] === 'view') throw new Error('fixture release does not exist')
      return ''
    }
    syncBuiltinESMExports()
  `
  execFileSync(
    process.execPath,
    [
      '--import',
      `data:text/javascript,${encodeURIComponent(stub)}`,
      script,
      'publish',
    ],
    { cwd, env: { ...env, GH_CALLS: join(cwd, 'gh-calls') } },
  )
  const calls = readFileSync(join(cwd, 'gh-calls'), 'utf8')
  assert.match(calls, /installers[\\/]SHA256SUMS\.txt/)
  assert.doesNotMatch(calls, /\*|\.exe|\.dmg|latest=true/)
  assert.ok(
    readFileSync(join(cwd, 'output'), 'utf8').includes('published=true'),
  )
})

test('same-SHA drafts recover interrupted uploads and publishing without retaining stale installers', (t) => {
  for (const failure of ['upload', 'edit']) {
    const { cwd } = repository(t)
    const decided = decideRelease(
      { ...prepared, forceRelease: true },
      shards(sha),
    )
    const released = classifyRelease(
      decided,
      packages(decided).filter((report) => report.platform === 'windows-x64'),
    )
    const directory = join(cwd, 'installers')
    mkdirSync(directory)
    const installer = `hibi-${released.version}-win-x64.exe`
    writeFileSync(join(directory, installer), 'verified windows')
    writeFileSync(
      join(directory, 'SHA256SUMS.txt'),
      `${'a'.repeat(64)}  ./${installer}\n`,
    )
    writeFileSync(
      join(directory, 'feed.json'),
      JSON.stringify({
        tag: released.tag,
        version: released.version,
        assets: {},
      }),
    )
    writeFileSync(join(directory, 'latest-mac.yml'), 'stale metadata')
    writeFileSync(join(cwd, 'release.json'), JSON.stringify(released))
    let fail = true
    const state = {
      isDraft: true,
      targetCommitish: sha,
      assets: [
        { name: 'stale-mac.dmg' },
        { name: 'latest-mac.yml' },
        { name: installer },
      ],
    }
    const calls = []
    const gh = (...args) => {
      calls.push(args)
      if (args[1] === 'view') return JSON.stringify(state)
      if (args[1] === 'delete-asset')
        state.assets = state.assets.filter(
          (asset) => asset.name !== args.at(-1),
        )
      if (args[1] === 'upload') {
        assert.ok(
          args.includes('--clobber'),
          'only a verified same-SHA draft is overwritten',
        )
        for (const path of args.slice(3).filter((arg) => arg !== '--clobber')) {
          const name = path.split('/').at(-1)
          assert.ok(readFileSync(path).length || name === 'SHA256SUMS.txt')
          state.assets = [
            ...state.assets.filter((asset) => asset.name !== name),
            { name },
          ]
        }
      }
      if (args[1] === failure && fail) {
        fail = false
        throw new Error('interrupted')
      }
      if (args[1] === 'edit') state.isDraft = false
      return ''
    }
    assert.throws(
      () => publishRelease(released, directory, 'owner/repo', gh),
      /interrupted/,
    )
    assert.equal(state.isDraft, true)
    assert.deepEqual(publishRelease(released, directory, 'owner/repo', gh), {
      published: true,
      announce: true,
    })
    assert.ok(!state.assets.some((asset) => asset.name === 'stale-mac.dmg'))
    assert.ok(!state.assets.some((asset) => asset.name === 'latest-mac.yml'))
    assert.equal(state.isDraft, false)
    const before = calls.length
    assert.deepEqual(publishRelease(released, directory, 'owner/repo', gh), {
      published: false,
      announce: false,
    })
    assert.equal(
      calls.length,
      before + 1,
      'published release is only read, never overwritten',
    )
    state.isDraft = true
    state.targetCommitish = 'b'.repeat(40)
    assert.throws(
      () => publishRelease(released, directory, 'owner/repo', gh),
      /checked revision/,
    )
  }
})
