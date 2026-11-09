import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { createServer } from 'vite'
import { fakeDom } from './obsidian/dom.mjs'
import { readFixturePlugin } from './obsidian/harness.mjs'

async function modules(t) {
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
  })
  t.after(() => server.close())
  return (path) => server.ssrLoadModule(`/src/addons/obsidian/${path}`)
}

test('commands preserve public IDs and use the palette captured editor with documented callback precedence', async (t) => {
  const load = await modules(t)
  const { Plugin } = await load('api/core/plugin.tsx')
  const { Component } = await load('api/core/component.ts')
  const commands = new Map()
  const disposed = []
  const hibi = {
    commands: {
      register(command) {
        assert.match(command.id, /^[a-z][a-z0-9-]*$/)
        commands.set(command.id, command)
        return () => {
          commands.delete(command.id)
          disposed.push(command.id)
        }
      },
    },
  }
  const owner = new Component()
  const app = {}
  const manifest = (await readFixturePlugin('host-smoke')).manifest
  const execution = { source: 'palette', view: { viewId: 'captured-left' } }
  const editor = {}
  const view = {}
  let active = true
  let simple = 0
  let checked = 0
  let edited = 0
  const plugin = new Plugin(app, manifest, {
    hibi,
    owner,
    vaultId: 'vault',
    idPrefix: 'pfixture',
    isCurrent: () => !plugin.isUnloaded,
    contributions: [
      {
        commandEditor: (context) => {
          assert.equal(context, execution)
          return active ? { editor, view } : null
        },
      },
    ],
  })
  const command = plugin.addCommand({
    id: 'some:unicode/漢字',
    name: 'Edit',
    callback: () => simple++,
    checkCallback: () => {
      checked++
      return true
    },
    editorCheckCallback: (checking, actualEditor, actualView) => {
      assert.equal(actualEditor, editor)
      assert.equal(actualView, view)
      if (!checking) edited++
      return true
    },
  })
  assert.equal(command.id, 'host-smoke:some:unicode/漢字')
  const registered = [...commands.values()][0]
  assert.equal(registered.when(execution), true)
  await registered.run(execution)
  assert.deepEqual([simple, checked, edited], [0, 0, 1])
  active = false
  assert.equal(registered.when(execution), false)
  await registered.run(execution)
  assert.equal(edited, 1)
  plugin.removeCommand('some:unicode/漢字')
  plugin.unload()
  owner.unload()
  assert.equal(commands.size, 0)
  assert.equal(disposed.length, 1)
  await assert.rejects(plugin.saveData({ late: true }), /unloaded/)
})

test('requestUrl uses the main network policy and creates convenience promises only when accessed', async (t) => {
  const load = await modules(t)
  const { createRequestUrl } = await load('api/core/network.ts')
  const { Component } = await load('api/core/component.ts')
  const owner = new Component()
  t.after(() => owner.unload())
  const calls = []
  let allowed = true
  const native = {
    async invoke(_method, input) {
      calls.push(input.request)
      if (!allowed) throw new Error('permission-denied')
      return {
        status: 200,
        headers: {},
        arrayBuffer: new TextEncoder().encode('plain text').buffer,
      }
    },
  }
  const requestUrl = createRequestUrl(owner, 'fixture', native.invoke)
  const request = requestUrl('https://example.test')
  assert.equal(await request.text, 'plain text')
  assert.equal(
    new TextDecoder().decode(await request.arrayBuffer),
    'plain text',
  )
  await assert.rejects(request.json, SyntaxError)
  assert.deepEqual(calls, [{ url: 'https://example.test' }])
  assert.equal(
    await requestUrl({ url: 'https://example.test', method: 'POST' }).text,
    'plain text',
  )
  assert.equal(
    await requestUrl({
      url: 'https://example.test',
      headers: { Authorization: 'fixture' },
    }).text,
    'plain text',
  )
  assert.equal(calls.length, 3)
  allowed = false
  await assert.rejects(requestUrl('https://example.test'), /permission-denied/)
})

test('yaml, normalized paths and cancelable debounce retain their public behavior', async (t) => {
  const load = await modules(t)
  const { parseYaml, stringifyYaml, normalizePath, debounce } = await load(
    'api/core/utilities.ts',
  )
  assert.deepEqual(
    parseYaml(stringifyYaml({ list: ['one', 'two'], enabled: true })),
    { list: ['one', 'two'], enabled: true },
  )
  assert.equal(
    normalizePath(`/folder\\note//e${String.fromCharCode(0x301, 0xa0)}/`),
    'folder/note/é ',
  )
  assert.equal(normalizePath('a\u202fb\u2007c'), 'a b c')
  let count = 0
  const callback = debounce(
    (value) => {
      count++
      return value
    },
    3600000,
    true,
  )
  callback('first')
  callback('last')
  assert.equal(callback.run(), 'last')
  assert.equal(count, 1)
  callback('cancelled')
  callback.cancel()
  assert.equal(callback.run(), undefined)
  assert.equal(count, 1)
})

test('CommonJS script wrapper reports refused fixture imports without executing Node code', async (t) => {
  const load = await modules(t)
  const { wrapObsidianPlugin } = await load('package.ts')
  const { requireObsidianHostModule } = await load('api/registry.ts')
  const fixture = await readFixturePlugin('host-denied')
  let failure
  vm.runInNewContext(wrapObsidianPlugin(fixture.main, 'fixture'), {
    __hibiObsidianHost: {
      take(identity) {
        assert.equal(identity, 'fixture')
        return {
          require: requireObsidianHostModule,
          loaded() {
            assert.fail('denied fixture loaded')
          },
          failed(error) {
            failure = error.message
          },
        }
      },
    },
  })
  assert.match(failure, /Unsupported Obsidian plugin import: node:fs/)
})

test('stale modal completion cannot close or detach a reopened modal', async (t) => {
  const load = await modules(t)
  const { Component } = await load('api/core/component.ts')
  const { Keymap, Scope } = await load('api/core/keymap.ts')
  const { createUiApi } = await load('api/core/ui.tsx')
  fakeDom(t)
  const owner = new Component()
  t.after(() => owner.unload())
  const app = { scope: new Scope(), keymap: new Keymap() }
  const handles = []
  const hibi = {
    dialogs: {
      open() {
        let resolve
        const result = new Promise((done) => {
          resolve = done
        })
        const handle = {
          result,
          closed: 0,
          close() {
            handle.closed++
            resolve(null)
          },
        }
        handles.push(handle)
        return handle
      },
    },
  }
  const { Modal } = createUiApi({ hibi, owner, app, name: 'fixture' })
  const modal = new Modal(app)
  let closed = 0
  modal.onClose = () => {
    closed++
  }
  modal.scope.register([], 'x', () => false)
  modal.open()
  modal.close()
  modal.open()
  await Promise.resolve()
  assert.equal(closed, 1)
  assert.equal(
    app.keymap.handle({
      key: 'x',
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      preventDefault() {},
    }),
    true,
  )
  owner.unload()
  assert.equal(handles[0].closed, 1)
  assert.equal(handles[1].closed, 1)
  assert.equal(closed, 2)
})

test('toggle clicks honor disablement and noninstant sliders notify on committed changes', async (t) => {
  const load = await modules(t)
  const { ToggleComponent, SliderComponent, ColorComponent } = await load(
    'api/core/settings.ts',
  )
  const document = fakeDom(t)
  const parent = document.createElement('div')
  const changes = []
  const toggle = new ToggleComponent(parent)
    .setTooltip('Fixture tooltip')
    .onChange((value) => {
      changes.push(value)
    })
  toggle.onClick()
  toggle.setDisabled(true).onClick()
  toggle.setDisabled(false).onClick()
  assert.deepEqual(changes, [true, false])
  assert.equal(toggle.toggleEl.title, 'Fixture tooltip')
  const values = []
  const slider = new SliderComponent(parent)
    .setLimits(null, 10, 1)
    .setInstant(false)
    .setValue(3)
    .onChange((value) => {
      values.push(value)
    })
  assert.equal(slider.sliderEl.getAttribute('min'), null)
  slider.sliderEl.value = '6'
  slider.sliderEl.dispatchEvent(new Event('input'))
  assert.deepEqual(values, [])
  slider.sliderEl.dispatchEvent(new Event('change'))
  assert.deepEqual(values, [6])
  slider.setInstant(true)
  slider.sliderEl.value = '7'
  slider.sliderEl.dispatchEvent(new Event('input'))
  slider.sliderEl.dispatchEvent(new Event('change'))
  assert.deepEqual(values, [6, 7])
  const color = new ColorComponent(parent).setValueRgb({ r: 255, g: 0, b: 0 })
  assert.equal(color.getValue(), '#ff0000')
  assert.deepEqual(color.getValueHsl(), { h: 0, s: 100, l: 50 })
  color.setValueHsl({ h: 120, s: 100, l: 50 })
  assert.deepEqual(color.getValueRgb(), { r: 0, g: 255, b: 0 })
})

test('menus are components and their show and hide methods return the same instance', async (t) => {
  const load = await modules(t)
  const { Component } = await load('api/core/component.ts')
  const { createUiApi } = await load('api/core/ui.tsx')
  fakeDom(t)
  const owner = new Component()
  let dismissed = 0
  let hidden = 0
  const { Menu } = createUiApi({
    owner,
    app: {},
    name: 'fixture',
    hibi: {
      menus: {
        open() {
          return {
            close() {
              dismissed++
            },
          }
        },
      },
    },
  })
  const menu = new Menu()
  assert.ok(menu instanceof Component)
  menu.onHide(() => {
    hidden++
  })
  assert.equal(menu.showAtPosition({ x: 0, y: 0 }), menu)
  assert.equal(menu.hide(), menu)
  assert.deepEqual([dismissed, hidden], [1, 1])
  assert.equal(menu.showAtMouseEvent({ clientX: 1, clientY: 1 }), menu)
  owner.unload()
  assert.deepEqual([dismissed, hidden], [2, 2])
})

test('notices preserve live fragments in Hibi’s shared toast shell and dismiss on unload', async (t) => {
  const sharedNotices = []
  let dismissed = 0
  const load = await modules(t)
  const { Component } = await load('api/core/component.ts')
  const { createUiApi } = await load('api/core/ui.tsx')
  const document = fakeDom(t)
  const owner = new Component()
  t.after(() => owner.unload())
  const { Notice } = createUiApi({
    owner,
    app: {},
    name: 'fixture',
    hibi: {
      toasts: {
        getPreferences: () => ({ position: 'bottom-right' }),
        show: (options) => {
          assert.equal(options.duration, 0)
          assert.ok(
            options.content,
            'live content must use the shared toast shell',
          )
          sharedNotices.push(options)
          return { dismiss: () => dismissed++, update() {} }
        },
      },
    },
  })
  const fragment = document.createDocumentFragment()
  const strong = document.createElement('strong')
  strong.textContent = 'Live content'
  fragment.append(strong)
  const notice = new Notice(fragment, 0)
  assert.equal(sharedNotices.length, 1)
  assert.equal(notice.noticeEl, notice.messageEl)
  assert.equal(notice.messageEl.contains(strong), true)
  assert.equal(notice.containerEl.contains(strong), true)
  const replacement = document.createDocumentFragment()
  const link = document.createElement('a')
  replacement.append(link)
  assert.equal(notice.setMessage(replacement), notice)
  assert.equal(notice.messageEl.contains(link), true)
  assert.equal(notice.messageEl.contains(strong), false)
  owner.unload()
  assert.equal(document.body.children.length, 0)
  assert.equal(dismissed, 1)
})

test('plugin command IDs survive replacement by a package with a new content hash', async (t) => {
  const load = await modules(t)
  const { ObsidianHost } = await load('runtime.ts')
  const { wrapObsidianPlugin } = await load('package.ts')
  const fixture = await readFixturePlugin('host-smoke')
  const document = fakeDom(t)
  window.hibi = { invokeAddonProfile: async () => crypto.randomUUID() }
  const append = document.head.append.bind(document.head)
  document.head.append = (script) => {
    append(script)
    queueMicrotask(() => {
      vm.runInNewContext(
        wrapObsidianPlugin(fixture.main, script.dataset.obsidianPlugin),
        { __hibiObsidianHost: window.__hibiObsidianHost },
      )
      script.onload?.()
    })
  }
  const ids = []
  let descriptor = {
    manifest: fixture.manifest,
    hash: 'a'.repeat(64),
    enabled: true,
    hasStyles: false,
  }
  const hibi = {
    native: {
      query: async (method) => (method === 'list' ? [descriptor] : {}),
      invoke: async () => {},
    },
    commands: {
      register(command) {
        ids.push(command.id)
        return () => {}
      },
    },
  }
  const host = new ObsidianHost(hibi, 'fixture-vault')
  t.after(() => host.stop())
  await host.start()
  const bridge = window.__hibiObsidianHost
  const bridgeProperty = Object.getOwnPropertyDescriptor(
    window,
    '__hibiObsidianHost',
  )
  assert.equal(bridgeProperty.configurable, false)
  assert.equal(bridgeProperty.writable, false)
  assert.equal(Object.isFrozen(bridge), true)
  assert.throws(
    () => Object.defineProperty(window, '__hibiObsidianHost', { value: {} }),
    TypeError,
  )
  const get = Map.prototype.get
  try {
    Map.prototype.get = () => ({ activate() {} })
    assert.throws(() => bridge.take('not-a-pending-load'), /no longer current/)
  } finally {
    Map.prototype.get = get
  }
  descriptor = { ...descriptor, hash: 'b'.repeat(64) }
  await host.refresh()
  assert.equal(ids.length, 2)
  assert.equal(ids[1], ids[0])
  host.stop()
  assert.equal(window.__hibiObsidianHost, bridge)
  assert.equal(document.head.children.length, 0)
  assert.equal(typeof HTMLElement.prototype.createEl, 'undefined')
})

test('trusted workspace holds enabled plugins without their own full-access grant before any source runs', async (t) => {
  const load = await modules(t)
  const { ObsidianHost } = await load('runtime.ts')
  const fixture = await readFixturePlugin('host-smoke')
  const document = fakeDom(t)
  window.hibiObsidianDesktop = {
    load() {
      throw new Error('ordinary plugin reached Node')
    },
  }
  const descriptor = {
    manifest: fixture.manifest,
    hash: 'a'.repeat(64),
    enabled: true,
    hasStyles: false,
  }
  const host = new ObsidianHost(
    {
      native: {
        query: async (method) => (method === 'list' ? [descriptor] : null),
      },
    },
    'empty',
  )
  t.after(() => host.stop())
  await host.start()
  assert.equal(host.plugins.size, 0)
  assert.match(
    host.errors.get(descriptor.manifest.id),
    /Paused.*full computer access/,
  )
  assert.equal(document.head.children.length, 0)
  assert.equal(typeof HTMLElement.prototype.createEl, 'undefined')
  descriptor.enabled = false
  await host.refresh()
  assert.equal(host.errors.has(descriptor.manifest.id), false)
})

test('disabling a plugin cancels resources during pending onload and cannot revive it', async (t) => {
  const load = await modules(t)
  const { ObsidianHost } = await load('runtime.ts')
  const { wrapObsidianPlugin } = await load('package.ts')
  const fixture = await readFixturePlugin('host-smoke')
  const document = fakeDom(t)
  window.hibi = { invokeAddonProfile: async () => crypto.randomUUID() }
  const started = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const state = {
    started: started.resolve,
    finish: finish.promise,
    cleaned: 0,
    events: 0,
  }
  const source = `const {Plugin} = require('obsidian');
    module.exports = class extends Plugin { async onload() {
      this.register(() => fixtureState.cleaned++);
      this.registerDomEvent(document, 'pending-unload', () => fixtureState.events++);
      fixtureState.started();
      await fixtureState.finish;
    } }`
  const append = document.head.append.bind(document.head)
  document.head.append = (script) => {
    append(script)
    queueMicrotask(() => {
      vm.runInNewContext(
        wrapObsidianPlugin(source, script.dataset.obsidianPlugin),
        {
          __hibiObsidianHost: window.__hibiObsidianHost,
          fixtureState: state,
          document,
        },
      )
      script.onload?.()
    })
  }
  const descriptor = {
    manifest: fixture.manifest,
    hash: 'c'.repeat(64),
    enabled: true,
    hasStyles: false,
  }
  const host = new ObsidianHost(
    { native: { query: async () => [descriptor] } },
    'empty',
  )
  t.after(() => host.stop())
  const activating = host.start()
  await started.promise
  descriptor.enabled = false
  host.unload(fixture.manifest.id)
  document.dispatchEvent(new Event('pending-unload'))
  assert.equal(state.cleaned, 1)
  assert.equal(state.events, 0)
  assert.equal(document.head.children.length, 0)
  assert.equal(typeof HTMLElement.prototype.createEl, 'undefined')
  finish.resolve()
  await activating
  assert.equal(host.plugins.size, 0)
  assert.equal(host.errors.size, 0)
})
