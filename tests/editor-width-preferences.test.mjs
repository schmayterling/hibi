import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: `export { default as addon } from './src/addons/editor-width/index'
      export * from './src/addons/editor-width/preferences'`,
    resolveDir: resolve('.'),
  },
  bundle: true,
  format: 'cjs',
  write: false,
})

function fixture(initial = {}) {
  const values = new Map(Object.entries(initial))
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
  const window = new EventTarget()
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module,
    localStorage,
    window,
    Event,
    // Node has no CSS engine. Model its length-unit check at the browser boundary.
    CSS: {
      supports: (property, value) =>
        property === 'width' && /^1(?:px|rem|ch|vw|dvw|cqw|%|q)$/.test(value),
    },
  })
  return { ...module.exports, values, localStorage, window }
}

test('width preferences preserve the previous width, custom units, range clamps, and cap state', () => {
  const settings = fixture({ 'editor-width.pixels': '940' })
  assert.equal(settings.getPreferences().width, 940)
  for (const unit of ['rem', 'ch', 'vw', 'dvw', 'cqw', '%', 'q']) {
    settings.setPreferences({ minimum: 20, maximum: 100, width: 65.5, unit })
    assert.equal(settings.getPreferences().unit, unit)
    assert.equal(settings.getPreferences().width, 65.5)
  }
  settings.setPreferences({ capped: false })
  const restored = fixture(Object.fromEntries(settings.values))
  assert.equal(restored.getPreferences().capped, false)
  assert.equal(restored.getPreferences().width, 65.5)
  restored.setPreferences({ maximum: 50 })
  assert.equal(restored.getPreferences().width, 50)
  restored.setPreferences({ minimum: 45, width: 30 })
  assert.equal(restored.getPreferences().width, 45)
  restored.setPreferences({ unit: 'px; color: red' })
  assert.equal(restored.getPreferences().unit, 'px')
  assert.equal(restored.validUnit('deg'), false)
  restored.setPreferences({ minimum: 500, maximum: 10 })
  assert.equal(restored.getPreferences().minimum, 320)
  assert.equal(restored.getPreferences().maximum, 1600)
  settings.values.set('editor-width.preferences', '{invalid')
  assert.equal(settings.getPreferences().width, 940)
})

test('width controls update live, restore the cap, and stop observing preferences on shutdown', () => {
  const settings = fixture()
  const items = new Map()
  const commands = new Map()
  let css = ''
  settings.addon.start({
    commands: {
      register: (command) => commands.set(command.id, command),
    },
    styles: {
      register: () => ({
        update: (value) => {
          css = value
        },
      }),
    },
    statusBar: {
      register: (item) => {
        items.set(item.id, item)
        return {
          update: (changes) =>
            items.set(item.id, { ...items.get(item.id), ...changes }),
        }
      },
    },
  })
  assert.equal(items.get('cap').toggle.checked, true)
  assert.equal(commands.get('toggle').menu.location, 'app')
  items.get('width').slider.onChange(720)
  const capped = css
  items.get('cap').toggle.onChange(false)
  assert.equal(css, '')
  assert.equal(items.get('width').slider.disabled, true)
  assert.equal(items.get('width').slider.value, 720)
  items.get('cap').toggle.onChange(true)
  assert.equal(css, capped)
  assert.equal(items.get('width').slider.disabled, false)
  settings.setPreferences({ minimum: 40, maximum: 120, unit: 'ch', width: 80 })
  assert.equal(items.get('width').slider.min, 40)
  assert.equal(items.get('width').slider.max, 120)
  assert.equal(items.get('width').slider.valueText, '80ch')
  assert.match(css, /\b80ch\b/)
  const saved = JSON.parse(settings.values.get('editor-width.preferences'))
  settings.localStorage.setItem(
    'editor-width.preferences',
    JSON.stringify({ ...saved, width: 90 }),
  )
  settings.window.dispatchEvent(
    Object.assign(new Event('storage'), {
      key: 'editor-width.preferences',
      storageArea: settings.localStorage,
    }),
  )
  assert.equal(items.get('width').slider.value, 90)
  settings.setPreferences({ showSlider: false, showToggle: false })
  assert.equal(items.get('width').label, '')
  assert.equal(items.get('cap').label, '')
  const widthBeforeToggle = settings.getPreferences().width
  commands.get('toggle').run()
  assert.equal(settings.getPreferences().capped, false)
  assert.equal(css, '')
  commands.get('toggle').run()
  assert.equal(settings.getPreferences().capped, true)
  assert.equal(settings.getPreferences().width, widthBeforeToggle)
  settings.setPreferences({ showSlider: true, showToggle: true })
  assert.equal(items.get('width').label, 'Editor width')
  assert.equal(items.get('cap').label, 'Width cap')
  settings.addon.stop()
  settings.setPreferences({ width: 100 })
  assert.equal(items.get('width').slider.value, 90)
})
