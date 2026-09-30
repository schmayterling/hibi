import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultHotkeys, restoreHotkeys } from '../src/shared/hotkeys.ts'

test('tab navigation defaults use the platform modifier', () => {
  assert.equal(defaultHotkeys('darwin')['previous-tab'], 'meta+alt+arrowleft')
  assert.equal(defaultHotkeys('darwin')['next-tab'], 'meta+alt+arrowright')
  assert.equal(defaultHotkeys('linux')['previous-tab'], 'ctrl+alt+arrowleft')
  assert.equal(defaultHotkeys('win32')['next-tab'], 'ctrl+alt+arrowright')
})

test('old shortcut settings gain tab navigation without taking user bindings', () => {
  const stored = { ...defaultHotkeys('darwin'), _version: 2 }
  delete stored['previous-tab']
  delete stored['next-tab']
  assert.equal(
    restoreHotkeys(stored, 'darwin')['next-tab'],
    'meta+alt+arrowright',
  )
  stored.find = 'meta+alt+arrowleft'
  const restored = restoreHotkeys(stored, 'darwin')
  assert.equal(restored.find, stored.find)
  assert.equal(restored['previous-tab'], '')
  assert.equal(restored['next-tab'], 'meta+alt+arrowright')
})

test('explicit tab navigation bindings and cleared bindings survive restore', () => {
  const stored = {
    ...defaultHotkeys('darwin'),
    _version: 2,
    'previous-tab': 'meta+alt+p',
    'next-tab': '',
  }
  const restored = restoreHotkeys(stored, 'darwin')
  assert.equal(restored['previous-tab'], stored['previous-tab'])
  assert.equal(restored['next-tab'], '')
})
