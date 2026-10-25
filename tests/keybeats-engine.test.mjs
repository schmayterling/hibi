import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'

const source = await readFile('src/addons/keybeats/engine.ts', 'utf8')
const run = new Function(
  'environment',
  `const { AudioContext, context, window, document, getPreferences, setPreferences,
    settingsEvent, profiles, urls, fetch, setTimeout, clearTimeout, Volume2, VolumeX } = environment
  ${stripTypeScriptTypes(source.slice(source.indexOf('export function startKeybeats'))).replace('export function', 'function')}
  return startKeybeats(context)`,
)
const settle = () => new Promise((resolve) => setImmediate(resolve))
const key = (phase = 'down', code = 'KeyA') => ({
  phase,
  code,
  key: 'a',
  repeat: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
})

async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const window = new EventTarget()
  const document = new EventTarget()
  document.hidden = false
  document.activeElement = { closest: () => true }
  let listener,
    stopped = false,
    resumeGate
  let preferences = { profile: 'first', volume: 0.15, muted: false }
  const events = [],
    fetched = [],
    voices = []
  const audio = {
    state: 'running',
    destination: {},
    createGain: () => ({ gain: {}, connect() {}, disconnect() {} }),
    decodeAudioData: async (bytes) => bytes,
    createBufferSource() {
      const voice = {
        connect() {},
        disconnect() {},
        start() {
          assert.equal(audio.state, 'running')
          events.push('start')
        },
        stop() {
          events.push('stop')
        },
      }
      voices.push(voice)
      return voice
    },
    async suspend() {
      events.push('suspend')
      audio.state = 'suspended'
    },
    async resume() {
      events.push('resume')
      await resumeGate
      audio.state = 'running'
    },
    async close() {
      events.push('close')
      audio.state = 'closed'
    },
  }
  const stop = run({
    AudioContext: new Proxy(class {}, {
      construct() {
        events.push('construct')
        return audio
      },
    }),
    context: {
      toolbar: { register: () => ({ update() {}, dispose() {} }) },
      editor: {
        onKeyEvent(callback) {
          listener = callback
          return () => {
            listener = undefined
          }
        },
      },
      notify: (message) => assert.fail(message),
    },
    window,
    document,
    getPreferences: () => preferences,
    setPreferences() {},
    settingsEvent: 'settings',
    profiles: ['first', 'second'].map((id) => ({
      id,
      press: { GENERIC: id },
      release: { GENERIC: id },
    })),
    urls: { './sounds/first': 'first', './sounds/second': 'second' },
    async fetch(url) {
      fetched.push(url)
      return { ok: true, arrayBuffer: async () => ({ url }) }
    },
    setTimeout,
    clearTimeout,
    Volume2: null,
    VolumeX: null,
  })
  const dispose = () => {
    if (stopped) return
    stopped = true
    stop()
  }
  t.after(dispose)
  await settle()
  return {
    audio,
    events,
    fetched,
    voices,
    stop: dispose,
    send: (event = key()) => listener?.(event),
    configure(changes) {
      preferences = { ...preferences, ...changes }
      window.dispatchEvent(new Event('settings'))
    },
    blur: () => window.dispatchEvent(new Event('blur')),
    leaveEditor() {
      document.activeElement = { closest: () => null }
      document.dispatchEvent(new Event('focusin'))
    },
    focus: () => window.dispatchEvent(new Event('focus')),
    hide() {
      document.hidden = true
      document.dispatchEvent(new Event('visibilitychange'))
    },
    deferResume() {
      resumeGate = new Promise((resolve) => {
        this.finishResume = resolve
      })
    },
  }
}

test('prepared audio suspends until eligible playback has resumed', async (t) => {
  const f = await fixture(t)
  assert.equal(f.audio.state, 'suspended')
  f.deferResume()
  f.send()
  f.send(key('up'))
  await settle()
  assert.equal(f.events.filter((event) => event === 'start').length, 0)
  f.finishResume()
  await settle()
  assert.equal(f.events.filter((event) => event === 'start').length, 2)
  assert.equal(f.events.filter((event) => event === 'construct').length, 1)
})

test('idle suspension follows last input and playback resumes without another constructor', async (t) => {
  const f = await fixture(t)
  f.send()
  await settle()
  assert.equal(f.audio.state, 'running')
  t.mock.timers.tick(9999)
  assert.equal(f.audio.state, 'running')
  f.send(key('up'))
  await settle()
  t.mock.timers.tick(9999)
  assert.equal(f.audio.state, 'running')
  t.mock.timers.tick(1)
  await settle()
  assert.equal(f.audio.state, 'suspended')
  f.send()
  await settle()
  assert.equal(f.audio.state, 'running')
  assert.equal(f.events.filter((event) => event === 'construct').length, 1)
  assert.equal(f.events.filter((event) => event === 'start').length, 3)
})

for (const reason of [
  'mute',
  'zero volume',
  'blur',
  'hidden',
  'idle',
  'editor focus',
]) {
  test(`audio suspends on ${reason} and cancels pending playback`, async (t) => {
    const f = await fixture(t)
    f.deferResume()
    f.send()
    await settle()
    if (reason === 'mute') f.configure({ muted: true })
    if (reason === 'zero volume') f.configure({ volume: 0 })
    if (reason === 'blur') f.blur()
    if (reason === 'hidden') f.hide()
    if (reason === 'idle') t.mock.timers.tick(10000)
    if (reason === 'editor focus') f.leaveEditor()
    const suspensions = f.events.filter((event) => event === 'suspend').length
    assert.ok(suspensions > 1)
    f.finishResume()
    await settle()
    assert.equal(f.events.filter((event) => event === 'start').length, 0)
    // A delayed resume must not leave inactive output running.
    assert.equal(f.audio.state, 'suspended')
  })
}

test('profile changes retain only selected buffers and discard stale playback', async (t) => {
  const f = await fixture(t)
  f.deferResume()
  f.send()
  await settle()
  f.configure({ profile: 'second' })
  await settle()
  f.finishResume()
  await settle()
  assert.equal(f.events.filter((event) => event === 'start').length, 0)
  f.configure({ profile: 'first' })
  await settle()
  assert.deepEqual(f.fetched, ['first', 'second', 'first'])
})

test('stop invalidates resumed playback, removes listeners and clears idle work', async (t) => {
  const f = await fixture(t)
  f.deferResume()
  f.send()
  await settle()
  f.stop()
  f.finishResume()
  await settle()
  const count = f.events.length
  t.mock.timers.tick(10000)
  f.blur()
  f.hide()
  f.configure({ muted: true })
  await settle()
  assert.equal(f.events.length, count)
  assert.equal(f.events.filter((event) => event === 'start').length, 0)
  assert.ok(f.events.includes('close'))
})

test('repeated and modified input stays silent; simultaneous voices stay bounded', async (t) => {
  const f = await fixture(t)
  for (const changes of [
    { repeat: true },
    { ctrlKey: true },
    { key: 'Process' },
  ])
    f.send({ ...key(), ...changes })
  await settle()
  assert.equal(f.events.filter((event) => event === 'start').length, 0)
  for (let i = 0; i < 40; i++) f.send(key('down', `Key${i}`))
  await settle()
  assert.equal(f.events.filter((event) => event === 'start').length, 40)
  assert.equal(f.events.filter((event) => event === 'stop').length, 8)
  f.blur()
  await settle()
  f.send(key())
  await settle()
  assert.equal(f.events.filter((event) => event === 'start').length, 40)
  f.focus()
  f.send(key())
  await settle()
  assert.equal(f.events.filter((event) => event === 'start').length, 41)
})
