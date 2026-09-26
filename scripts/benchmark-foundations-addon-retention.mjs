import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clickMenu } from '../tests/keyboard.mjs'
import { launchBenchmarkApp, waitForEditor } from './benchmark-flows.mjs'

const cycles = 20
const fixtures = [
  { id: 'retention-neutral', captureSettings: false },
  { id: 'retention-settings', captureSettings: true },
]

function fixtureSource(captureSettings) {
  return `
const observations = window.__hibiAddonRetention = {
  starts: 0,
  stops: 0,
  owners: [],
}

export default () => {
  const owner = { payload: new Array(32768).fill(observations.starts + 1) }
  observations.owners.push(new WeakRef(owner))
  const definition = {
    start() {
      owner.payload[0] = observations.starts + 1
      observations.starts++
    },
    stop() {
      owner.payload[0] = 0
      observations.stops++
    },
  }
  if (${captureSettings})
    definition.Settings = function Settings() {
      return owner.payload.length
    }
  return definition
}
`
}

async function installFixture(profile, { id, captureSettings }) {
  const folder = join(profile, 'installed-addons', id)
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id,
      name: id,
      description: 'Temporary addon retention benchmark fixture.',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      startup: 'background',
      capabilities: [],
      authors: [{ displayName: 'Hibi benchmark' }],
      entry: 'index.js',
    }),
  )
  await writeFile(join(folder, 'index.js'), fixtureSource(captureSettings))
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(join(profile, 'addons.json'), JSON.stringify({ [id]: false }))
}

async function sample(page, session, cycle) {
  // A completed stop is followed by separate renderer tasks before collection.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)))
  await session.send('HeapProfiler.collectGarbage')
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)))
  await session.send('HeapProfiler.collectGarbage')
  const heap = await session.send('Runtime.getHeapUsage')
  const owners = await page.evaluate(() => {
    const observed = window.__hibiAddonRetention
    const liveCycles =
      observed?.owners.flatMap((ref, index) =>
        ref.deref() ? [index + 1] : [],
      ) ?? []
    return {
      starts: observed?.starts ?? 0,
      stops: observed?.stops ?? 0,
      liveCycles,
    }
  })
  return {
    cycle,
    ...owners,
    liveOwners: owners.liveCycles.length,
    heap,
  }
}

function summary(samples) {
  const measured = samples.slice(1)
  const live = measured.map((sample) => sample.liveOwners)
  const firstFive = live.slice(0, 5)
  const lastFive = live.slice(-5)
  const mean = (values) =>
    values.reduce((sum, value) => sum + value, 0) / values.length
  const firstMean = mean(firstFive)
  const lastMean = mean(lastFive)
  const final = measured.at(-1)
  return {
    liveOwnersAfterWarmup: live.slice(1),
    finalLiveOwners: final.liveOwners,
    finalLiveCycles: final.liveCycles,
    firstFiveMean: firstMean,
    lastFiveMean: lastMean,
    pattern:
      Math.max(...live.slice(1)) <= 1
        ? 'zero or one owner after warmup in this run'
        : lastMean - firstMean >= 3 && final.liveOwners >= 4
          ? 'rising retained-owner count; investigate possible growth'
          : 'mixed counts; inspect per-cycle samples',
  }
}

async function runFixture(root, fixture) {
  const profile = join(root, fixture.id)
  await mkdir(profile)
  await installFixture(profile, fixture)
  const app = await launchBenchmarkApp(profile)
  let session
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    await waitForEditor(page)
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
    const toggle = page.locator(`#addon-${fixture.id}`)
    await toggle.waitFor()
    assert.equal(await toggle.isChecked(), false)
    session = await page.context().newCDPSession(page)
    await session.send('HeapProfiler.enable')
    const samples = [await sample(page, session, 0)]
    for (let cycle = 1; cycle <= cycles; cycle++) {
      await toggle.click()
      await page.waitForFunction(
        ({ id, cycle }) => {
          const input = document.getElementById(`addon-${id}`)
          return (
            input?.checked === true &&
            !input.disabled &&
            window.__hibiAddonRetention?.starts === cycle
          )
        },
        { id: fixture.id, cycle },
      )
      await toggle.click()
      await page.waitForFunction(
        ({ id, cycle }) => {
          const input = document.getElementById(`addon-${id}`)
          return (
            input?.checked === false &&
            !input.disabled &&
            window.__hibiAddonRetention?.stops === cycle
          )
        },
        { id: fixture.id, cycle },
      )
      const result = await sample(page, session, cycle)
      assert.equal(result.starts, cycle)
      assert.equal(result.stops, cycle)
      samples.push(result)
    }
    return { ...fixture, samples, summary: summary(samples) }
  } finally {
    try {
      if (session) await session.detach()
    } finally {
      await app.close()
    }
  }
}

const root = await mkdtemp(join(tmpdir(), 'hibi-addon-retention-'))
try {
  const results = []
  for (const fixture of fixtures) results.push(await runFixture(root, fixture))
  console.log(
    JSON.stringify(
      {
        runtime: process.version,
        platform: process.platform,
        arch: process.arch,
        cycles,
        ownerPayload: '32768-element JavaScript array per factory call',
        endpoint:
          'post-disable renderer task turns, forced CDP GC, then renderer Runtime.getHeapUsage and WeakRef liveness',
        caveats: [
          'The first cycle warms addon code, SDK imports, and settings UI; compare later cycles.',
          'A settings component can keep the latest owner through the installed addon descriptor. One live owner is consistent with bounded retention, not an accumulating leak.',
          'WeakRef collection and V8 heap sizes are nondeterministic. A 20-cycle rise is a signal, not proof of an unbounded leak.',
          'Runtime.getHeapUsage covers the renderer heap and backing storage, not total process RSS or native resources.',
        ],
        results,
      },
      null,
      2,
    ),
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
