import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { AddonHotkeys } from '../src/main/addon-hotkeys.ts'
import { validCommandMenu } from '../src/shared/addon-hotkeys.ts'
import { defaultHotkeys } from '../src/shared/hotkeys.ts'

test('menu descriptors bound installed command locations and ordering', () => {
  for (const location of ['app', 'explorer', 'editor'])
    assert.equal(
      validCommandMenu({ location, group: 'notes', order: -2 }),
      true,
    )
  for (const menu of [
    null,
    [],
    { location: 'other' },
    { location: 'editor', group: 'Not valid' },
    { location: 'app', order: 10001 },
    { location: 'explorer', order: 0.5 },
  ])
    assert.equal(validCommandMenu(menu), false)
})

async function withService(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-addon-hotkeys-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'addon-hotkeys.json')
  const service = new AddonHotkeys(file, 'darwin', defaultHotkeys('darwin'))
  await service.load()
  return { file, service }
}

test('portable addon defaults use the platform modifier', () => {
  for (const [platform, modifier] of [
    ['darwin', 'meta'],
    ['linux', 'ctrl'],
  ]) {
    const service = new AddonHotkeys(
      '/unused/addon-hotkeys.json',
      platform,
      defaultHotkeys(platform),
    )
    service.register({
      id: 'demo.capture',
      label: 'Capture',
      defaultShortcut: 'mod+alt+shift+f10',
      token: 'one',
    })
    assert.equal(
      service.resolve(`${modifier}+alt+shift+f10`)?.id,
      'demo.capture',
    )
  }
})

test('invalid saved bindings are preserved and defaults still load', async (t) => {
  const { file } = await withService(t)
  await writeFile(file, '{broken')
  const restored = new AddonHotkeys(file, 'darwin', defaultHotkeys('darwin'))
  await restored.load()
  const backup = (await readdir(dirname(file))).find((name) =>
    name.startsWith('addon-hotkeys.json.invalid-'),
  )
  assert.ok(backup)
  assert.equal(await readFile(join(dirname(file), backup), 'utf8'), '{broken')
  restored.register({
    id: 'demo.run',
    label: 'Run',
    defaultShortcut: 'mod+shift+j',
    token: 'one',
  })
  assert.equal(restored.resolve('meta+shift+j')?.id, 'demo.run')
  await restored.setOverride('demo.run', 'meta+shift+k')
  assert.equal(restored.resolve('meta+shift+k')?.id, 'demo.run')
})

test('core bindings win; addon collisions have stable precedence and visible conflicts', async (t) => {
  const { service } = await withService(t)
  service.register({
    id: 'zeta.open',
    label: 'Zeta Open',
    defaultShortcut: 'meta+shift+p',
    token: 'zeta-1',
  })
  service.register({
    id: 'alpha.open',
    label: 'Alpha Open',
    defaultShortcut: 'meta+shift+p',
    token: 'alpha-1',
  })
  service.register({
    id: 'alpha.palette',
    label: 'Addon Palette',
    defaultShortcut: 'meta+k',
    token: 'alpha-1',
  })
  assert.deepEqual(service.resolve('meta+shift+p'), {
    id: 'alpha.open',
    token: 'alpha-1',
    source: 'shortcut',
  })
  assert.equal(service.resolve('meta+k'), undefined)
  assert.deepEqual(
    service.bindings().find(({ id }) => id === 'zeta.open').conflictWith,
    {
      id: 'alpha.open',
      label: 'Alpha Open',
    },
  )
  assert.deepEqual(
    service.bindings().find(({ id }) => id === 'alpha.palette').conflictWith,
    {
      id: 'palette',
      label: 'Command palette',
    },
  )
  await assert.rejects(
    service.setOverride('zeta.open', 'meta+shift+p'),
    /Already used by Alpha Open/,
  )
  await assert.rejects(
    service.setOverride('zeta.open', 'meta+k'),
    /Already used by Command palette/,
  )
  await service.setOverride('zeta.open', 'meta+shift+j')
  assert.equal(service.resolve('meta+shift+j').id, 'zeta.open')
  service.register({
    id: 'beta.open',
    label: 'Beta Open',
    defaultShortcut: 'meta+shift+j',
    token: 'beta-1',
  })
  assert.deepEqual(
    service.bindings().find(({ id }) => id === 'beta.open').conflictWith,
    { id: 'zeta.open', label: 'Zeta Open' },
  )
  service.setCoreHotkeys({
    ...defaultHotkeys('darwin'),
    palette: 'meta+shift+j',
  })
  assert.equal(service.resolve('meta+shift+j'), undefined)
  assert.equal(
    service.bindings().find(({ id }) => id === 'zeta.open').shortcut,
    'meta+shift+j',
  )
  assert.equal(
    service.bindings().find(({ id }) => id === 'zeta.open').effectiveShortcut,
    '',
  )
})

test('user overrides survive disable, restart, upgrade, and stale disposal', async (t) => {
  const { file, service } = await withService(t)
  service.register({ id: 'demo.run', label: 'Run', token: 'old' })
  assert.equal(service.bindings()[0].defaultShortcut, '')
  await service.setOverride('demo.run', 'meta+shift+j')
  assert.equal(service.unregister('demo.run', 'old'), true)
  assert.equal(service.resolve('meta+shift+j'), undefined)
  const restarted = new AddonHotkeys(file, 'darwin', defaultHotkeys('darwin'))
  await restarted.load()
  restarted.register({
    id: 'demo.run',
    label: 'Run upgraded',
    defaultShortcut: 'meta+shift+t',
    token: 'new',
  })
  assert.equal(restarted.unregister('demo.run', 'old'), false)
  assert.deepEqual(restarted.resolve('meta+shift+j'), {
    id: 'demo.run',
    token: 'new',
    source: 'shortcut',
  })
  assert.equal(restarted.bindings()[0].overridden, true)
  assert.equal(restarted.bindings()[0].defaultShortcut, 'meta+shift+t')
  restarted.clearRegistrations()
  assert.deepEqual(restarted.bindings(), [])
  restarted.register({ id: 'demo.run', label: 'Run again', token: 'next' })
  assert.equal(restarted.resolve('meta+shift+j').id, 'demo.run')
  await restarted.resetOverride('demo.run')
  assert.equal(restarted.resolve('meta+shift+j'), undefined)
  assert.equal(restarted.bindings()[0].overridden, false)
})

test('menu items sort by group, order, and id, then leave with their owner', async (t) => {
  const { service } = await withService(t)
  service.register({
    id: 'demo.late',
    label: 'Late',
    token: 'one',
    menu: { location: 'app', group: 'tools', order: 2 },
  })
  service.register({
    id: 'demo.tie',
    label: 'Tie',
    token: 'one',
    menu: { location: 'app', group: 'tools', order: 1 },
  })
  service.register({
    id: 'demo.early',
    label: 'Early',
    token: 'one',
    menu: { location: 'app', group: 'tools', order: 1 },
  })
  service.register({ id: 'demo.hidden', label: 'Hidden', token: 'one' })
  assert.deepEqual(
    service.menuContributions().map(({ id }) => id),
    ['demo.early', 'demo.tie', 'demo.late'],
  )
  service.register({
    id: 'demo.early',
    label: 'New Early',
    token: 'two',
    menu: { location: 'app', group: 'tools', order: 1 },
  })
  assert.equal(service.unregister('demo.early', 'one'), false)
  assert.equal(service.menuContributions()[0].token, 'two')
  assert.equal(service.unregister('demo.early', 'two'), true)
  assert.deepEqual(
    service.menuContributions().map(({ id }) => id),
    ['demo.tie', 'demo.late'],
  )
})

test('writes serialize without dropping separate overrides', async (t) => {
  const { file, service } = await withService(t)
  service.register({ id: 'demo.one', label: 'One', token: 'first' })
  service.register({ id: 'demo.two', label: 'Two', token: 'first' })
  await Promise.all([
    service.setOverride('demo.one', 'meta+shift+j'),
    service.setOverride('demo.two', 'meta+shift+p'),
  ])
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    version: 1,
    overrides: {
      'demo.one': 'meta+shift+j',
      'demo.two': 'meta+shift+p',
    },
  })
  assert.throws(
    () =>
      service.register({
        id: 'demo.bad',
        label: 'Bad',
        defaultShortcut: 'meta+w',
        token: 'first',
      }),
    /This shortcut closes tabs/,
  )
})
