import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  readStyleSettings,
  styleSettingsCss,
} from '../src/addons/obsidian-themes/style-settings.ts'

const garden = () =>
  readFile(
    new URL(
      './obsidian/fixtures/themes/settings-garden/theme.css',
      import.meta.url,
    ),
    'utf8',
  )

test('Style Settings comments are read as data, tabs and all, with what is unusable reported', async () => {
  const { sections, skipped } = readStyleSettings(await garden())
  assert.deepEqual(
    sections.map((section) => [section.id, section.name]),
    [
      ['garden', 'Garden layout'],
      ['garden-extra', 'Second section'],
    ],
  )
  assert.deepEqual(
    sections[0].settings.map((item) => [item.id, item.type]),
    [
      ['garden-layout', 'heading'],
      ['garden-about', 'info-text'],
      ['garden-wide', 'class-toggle'],
      ['garden-quiet', 'class-toggle'],
      ['garden-density', 'class-select'],
      ['garden-gap', 'variable-number-slider'],
      ['garden-font', 'variable-text'],
      ['garden-weight', 'variable-select'],
      ['garden-leaf', 'variable-color'],
      ['garden-accent', 'variable-themed-color'],
    ],
  )
  // A class option that isn't a class name never becomes one.
  assert.deepEqual(
    sections[0].settings[4].options.map((option) => option.value),
    ['garden-cozy', 'garden-compact'],
  )
  assert.equal(skipped.length, 3)
  assert.match(skipped[0], /invalid id "bad id"/)
  assert.match(skipped[1], /setting type color-gradient/)
  assert.match(skipped[2], /unreadable settings/)
  assert.deepEqual(readStyleSettings('/* not settings */ a{}').sections, [])
})

test('defaults add only classes; chosen values become body classes and variables', async () => {
  const { sections } = readStyleSettings(await garden())
  assert.deepEqual(styleSettingsCss(sections, {}), {
    css: '',
    classes: ['garden-wide', 'garden-cozy'],
  })
  const chosen = styleSettingsCss(sections, {
    'garden@@garden-wide': false,
    'garden@@garden-quiet': true,
    'garden@@garden-density': 'garden-compact',
    'garden@@garden-gap': 20,
    'garden@@garden-font': 'Iowan Old Style',
    'garden@@garden-weight': '600',
    'garden@@garden-leaf': '#ff8000',
    'garden@@garden-accent@@light': '#112233',
    'garden@@garden-accent@@dark': '#ddeeff',
    'garden-extra@@garden-ratio': 2,
  })
  assert.deepEqual(chosen.classes, ['garden-quiet', 'garden-compact'])
  assert.equal(
    chosen.css,
    'body.css-settings-manager { --garden-gap: 20px; --garden-font: "Iowan Old Style"; --garden-weight: 600; --garden-leaf-r: 255; --garden-leaf-g: 128; --garden-leaf-b: 0; --garden-ratio: 2;}' +
      'body.css-settings-manager.theme-light { --garden-accent: #112233;}' +
      'body.css-settings-manager.theme-dark { --garden-accent: #ddeeff;}',
  )
})

test('values cannot leave their declaration, load anything or pick unlisted options', () => {
  const { sections } = readStyleSettings(`/* @settings
id: s
settings:
  - { id: t, type: variable-text, default: a }
  - { id: q, type: variable-text, default: a, quotes: true }
  - { id: v, type: variable-select, default: a, options: [a, b] }
  - { id: c, type: class-select, default: a, options: [a, b] }
  - { id: k, type: variable-color, format: hsl, default: "#000000" }
  - { id: theme-dark, type: class-toggle, default: true }
*/`)
  for (const text of [
    'red; } body { display: none',
    'url(https://evil.invalid/x.png)',
    'x /* y',
    '\\7d body{}',
    'x" ; --y: 1',
    'image-set(var(--z) 1x)',
    'rgb(1 2 3)',
  ]) {
    const { css } = styleSettingsCss(sections, { 's@@t': text })
    assert.equal(css, '', text)
  }
  const quoted = styleSettingsCss(sections, { 's@@q': '"}; body { x: y' })
  assert.doesNotMatch(quoted.css, /body \{ x/)
  const result = styleSettingsCss(sections, {
    's@@v': 'c',
    's@@c': 'evil',
    's@@k': 'red',
  })
  assert.equal(result.css, '')
  // Theme classes stay Hibi's to set.
  assert.deepEqual(result.classes, ['a'])
  assert.equal(
    styleSettingsCss(sections, { 's@@k': '#ff0000' }).css,
    'body.css-settings-manager { --k: hsl(0, 100%, 50%);}',
  )
})
