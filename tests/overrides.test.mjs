import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createAddonOverrides } from '../src/renderer/src/addon-overrides.ts'
import { electron } from './electron.mjs'

test('patches compose, preserve this, and remove owners independently', () => {
  const first = createAddonOverrides('first')
  const second = createAddonOverrides('second')
  const target = {
    factor: 2,
    calculate(value) {
      return this.factor * value
    },
  }
  const original = Object.getOwnPropertyDescriptor(target, 'calculate')
  first.patches.before(target, 'calculate', ([value]) => [value + 1])
  const undo = second.patches.after(
    target,
    'calculate',
    (_args, result) => result + 10,
  )
  assert.equal(target.calculate(3), 18)
  first.dispose()
  assert.equal(target.calculate(3), 16)
  undo()
  undo()
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(target, 'calculate'),
    original,
  )
  second.dispose()
})

test('replacement can skip or call next without replaying failed operations', async () => {
  const addon = createAddonOverrides('test')
  let calls = 0
  const target = {
    async save(value) {
      calls++
      return value
    },
  }
  const remove = addon.patches.instead(target, 'save', ([value], next) =>
    value ? next(`${value}!`) : Promise.resolve('skipped'),
  )
  addon.patches.after(target, 'save', (_args, result) =>
    result.then((value) => value.toUpperCase()),
  )
  assert.equal(await target.save('draft'), 'DRAFT!')
  assert.equal(await target.save(''), 'skipped')
  assert.equal(calls, 1)
  remove()
  assert.equal(await target.save('draft'), 'DRAFT')
  addon.patches.after(target, 'save', () => {
    throw new Error('failed hook')
  })
  assert.throws(() => target.save('draft'), /failed hook/)
  assert.equal(calls, 3)
  addon.dispose()
  assert.equal(await target.save('draft'), 'draft')
})

test('cleanup preserves external replacements and stopped addons cannot patch again', () => {
  const addon = createAddonOverrides('test')
  const target = { method: () => 'base' }
  addon.patches.instead(target, 'method', () => 'patched')
  target.method = () => 'external'
  assert.throws(
    () => addon.patches.before(target, 'method', () => {}),
    /changed outside/,
  )
  addon.dispose()
  assert.equal(target.method(), 'external')
  addon.patches.instead(target, 'method', () => 'late')
  assert.equal(target.method(), 'external')
  assert.throws(
    () =>
      createAddonOverrides('frozen').patches.before(
        Object.freeze(target),
        'method',
        () => {},
      ),
    TypeError,
  )
})

test('removing a patch inside its callback keeps the current invocation intact', () => {
  const addon = createAddonOverrides('test')
  const target = { value: () => 1 }
  const remove = addon.patches.before(target, 'value', () => remove())
  addon.patches.after(target, 'value', (_args, value) => value + 1)
  assert.equal(target.value(), 2)
  assert.equal(target.value(), 2)
  addon.dispose()
})

test('css overrides apply, update, keep priority, and clean up in a real renderer', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-overrides-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  const source = await readFile('src/renderer/src/addon-overrides.ts', 'utf8')
  const code = stripTypeScriptTypes(source).replace(
    'export function createAddonOverrides',
    'exports.createAddonOverrides = function createAddonOverrides',
  )
  const result = await page.evaluate((code) => {
    const exports = {}
    new Function('exports', code)(exports)
    const addon = exports.createAddonOverrides('fixture')
    const element = document.createElement('div')
    element.className = 'override-fixture'
    document.body.append(element)
    const baseline = getComputedStyle(element).color
    const style = addon.styles.register(
      'color',
      '.override-fixture { color: rgb(10, 20, 30); }',
    )
    const initial = getComputedStyle(element).color
    style.update('.override-fixture { color: rgb(30, 40, 50); }')
    const updated = getComputedStyle(element).color
    style.dispose()
    const restored = getComputedStyle(element).color
    addon.styles.register('color', '.override-fixture { color: red; }')
    style.update('.override-fixture { color: blue; }')
    const staleHandleIgnored = getComputedStyle(element).color
    addon.dispose()
    addon.styles.register('late', '.override-fixture { color: green; }')
    const remaining = document.querySelectorAll(
      'style[data-addon-style^="fixture."]',
    ).length

    const theme = exports.createAddonOverrides('theme')
    const later = exports.createAddonOverrides('later')
    theme.styles.register(
      'override',
      '.override-fixture { color: rgb(70, 80, 90); }',
      { priority: 'override' },
    )
    later.styles.register(
      'normal',
      '.override-fixture { color: rgb(90, 80, 70); }',
    )
    const prioritized = getComputedStyle(element).color
    const sheets = [
      ...document.head.querySelectorAll('style[data-addon-style]'),
    ]
    const normalBeforeOverride =
      sheets.findIndex((sheet) => sheet.dataset.addonStyle === 'later.normal') <
      sheets.findIndex((sheet) => sheet.dataset.addonStyle === 'theme.override')
    theme.dispose()
    const normalAfterDispose = getComputedStyle(element).color
    later.dispose()
    const priorityRestored = getComputedStyle(element).color
    element.remove()
    return {
      baseline,
      initial,
      updated,
      restored,
      staleHandleIgnored,
      remaining,
      prioritized,
      normalBeforeOverride,
      normalAfterDispose,
      priorityRestored,
    }
  }, code)
  assert.equal(result.initial, 'rgb(10, 20, 30)')
  assert.equal(result.updated, 'rgb(30, 40, 50)')
  assert.equal(result.restored, result.baseline)
  assert.equal(result.staleHandleIgnored, 'rgb(255, 0, 0)')
  assert.equal(result.remaining, 0)
  assert.equal(result.prioritized, 'rgb(70, 80, 90)')
  assert.equal(result.normalBeforeOverride, true)
  assert.equal(result.normalAfterDispose, 'rgb(90, 80, 70)')
  assert.equal(result.priorityRestored, result.baseline)
})
