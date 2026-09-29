import assert from 'node:assert/strict'
import test from 'node:test'
import { shortcutFromEvent } from '../src/shared/hotkeys.ts'

for (const [name, key, code, shiftKey, altKey, expected] of [
  ['dvorak close tab', 'w', 'Comma', false, false, 'meta+w'],
  ['dvorak settings', ',', 'KeyW', false, false, 'meta+,'],
  ['dvorak save', 's', 'Semicolon', false, false, 'meta+s'],
  ['caps lock', 'W', 'Comma', false, false, 'meta+w'],
  ['dvorak shifted settings', '<', 'KeyW', true, false, 'meta+shift+,'],
  ['azerty punctuation on letter key', ',', 'KeyM', false, false, 'meta+,'],
  [
    'shifted quote position stays physical',
    '{',
    'Quote',
    true,
    false,
    "meta+shift+'",
  ],
  [
    'shifted bracket position stays physical',
    '?',
    'BracketLeft',
    true,
    false,
    'meta+shift+[',
  ],
  ['digit position stays physical', '1', 'Digit7', true, false, 'meta+shift+7'],
  ['uk shifted digit', '"', 'Digit2', true, false, 'meta+shift+2'],
  ['uk shifted quote', '@', 'Quote', true, false, "meta+shift+'"],
  ['german shifted digit', '/', 'Digit7', true, false, 'meta+shift+7'],
  ['french unshifted digit', "'", 'Digit4', false, false, 'meta+4'],
  ['french unshifted minus', '-', 'Digit6', false, false, 'meta+6'],
  ['german option digit', '[', 'Digit5', false, true, 'meta+alt+5'],
  ['german sidebar default', '-', 'Slash', false, false, 'meta+/'],
  [
    'german side-by-side default',
    "'",
    'Backslash',
    true,
    false,
    'meta+shift+\\',
  ],
  ['mac option character', 'ß', 'KeyS', false, true, 'meta+alt+s'],
  ['cyrillic character', 'ц', 'KeyW', false, false, 'meta+w'],
  ['german bracket key', 'ü', 'BracketLeft', false, false, 'meta+['],
  ['space', ' ', 'Space', false, false, 'meta+space'],
  [
    'dead key retains physical fallback',
    'Dead',
    'KeyW',
    false,
    false,
    'meta+w',
  ],
  [
    'unidentified key retains physical fallback',
    'Unidentified',
    'Comma',
    false,
    false,
    'meta+,',
  ],
]) {
  test(`shortcut normalization: ${name}`, () => {
    assert.equal(
      shortcutFromEvent({
        key,
        code,
        shiftKey,
        ctrlKey: false,
        metaKey: true,
        altKey,
      }),
      expected,
    )
  })
}

test('AltGr symbols retain numeric shortcut positions', () => {
  assert.equal(
    shortcutFromEvent({
      key: '[',
      code: 'Digit8',
      shiftKey: false,
      ctrlKey: true,
      metaKey: false,
      altKey: true,
    }),
    'ctrl+alt+8',
  )
})
