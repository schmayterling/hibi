import assert from 'node:assert/strict'
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

const scheme = (id, name) => ({
  id,
  name,
  appearance: 'dark',
  author: 'Test',
  license: { name: 'MIT', text: 'Permission notice' },
  colors: {
    background: '#101820',
    surface: '#202830',
    ink: '#eeeeee',
    muted: '#aaaaaa',
    accent: '#88cccc',
    border: '#333333',
  },
})
const metadata = (id, fields) => ({
  id,
  name: id,
  description: 'Package styles fixture',
  kind: 'extension',
  apiVersion: 2,
  version: '1.0.0',
  authors: [{ displayName: 'Test' }],
  entry: 'index.js',
  capabilities: [],
  startup: 'background',
  ...fields,
})
async function writePackage(folder, manifest, files) {
  for (const [path, content] of Object.entries({
    'hibi-addon.json': JSON.stringify(manifest),
    'README.md': `# ${manifest.id}`,
    ...(manifest.entry ? { 'index.js': 'export default { start() {} }' } : {}),
    ...files,
  })) {
    await mkdir(dirname(join(folder, path)), { recursive: true })
    await writeFile(join(folder, path), content)
  }
}

test('package stylesheets and themes install, attach in order, and leave with their addon', {
  timeout: 60000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-package-styles-'))
  const profile = join(temp, 'profile')
  const sources = join(temp, 'sources')
  const source = (name) => join(sources, name)
  await writePackage(
    source('styled-addon'),
    metadata('styled-addon', {
      styles: ['styles/base.css', 'later.css', 'remote.css'],
      themes: ['themes/dusk.json', scheme('ember', 'Styled ember')],
    }),
    {
      'index.js': `export default () => ({ start(context) {
        window.styledStarts = (window.styledStarts || 0) + 1;
        window.styledSchemes = () => context.colorschemes.list().map((scheme) => scheme.id);
        window.styledUseDusk = () => context.colorschemes.setPreferences({ mode: 'dark', dark: 'styled-addon.dusk' });
        context.styles.register('runtime', '.styled-probe { outline-color: rgb(7, 8, 9); }');
        context.styles.register('override', '.styled-probe { text-decoration-color: rgb(10, 11, 12); }', { priority: 'override' });
      } });`,
      'styles/base.css': `@import 'parts/imported.css';
@font-face { font-family: styled-font; src: url('../assets/font.woff2') format('woff2'); }
.styled-probe { color: rgb(1, 2, 3); outline-color: rgb(1, 2, 3); text-decoration-color: rgb(1, 2, 3); font-family: styled-font; background-image: url('../assets/dot.png'); }`,
      'styles/parts/imported.css': '.styled-probe { --styled-import: yes; }',
      'later.css':
        '.styled-probe { color: rgb(4, 5, 6); outline-color: rgb(4, 5, 6); }',
      'remote.css': `@font-face { font-family: remote-font; src: url('https://example.invalid/font.woff2'); }
.styled-remote { font-family: remote-font; background-image: url('https://example.invalid/remote.png'); }`,
      'themes/dusk.json': JSON.stringify(scheme('dusk', 'Styled dusk')),
    },
  )
  await mkdir(join(source('styled-addon'), 'assets'))
  await copyFile(
    'node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2',
    join(source('styled-addon'), 'assets/font.woff2'),
  )
  await writeFile(
    join(source('styled-addon'), 'assets/dot.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    ),
  )
  await writePackage(
    source('fragile-addon'),
    metadata('fragile-addon', {
      styles: ['a.css', 'b.css'],
      themes: ['themes/fragile.json'],
    }),
    {
      'index.js': `export default () => ({ start() {
        if (localStorage.getItem('fragile-throw')) throw new Error('fragile start failed');
        window.fragileStarts = (window.fragileStarts || 0) + 1;
      } });`,
      'a.css': '.fragile-probe { color: rgb(20, 20, 20); }',
      'b.css': '.fragile-probe { outline-color: rgb(20, 20, 20); }',
      'themes/fragile.json': JSON.stringify(scheme('fragile', 'Fragile')),
    },
  )
  await writePackage(
    source('paper-theme'),
    metadata('paper-theme', {
      kind: 'theme',
      entry: undefined,
      capabilities: undefined,
      startup: undefined,
      themes: ['paper.json'],
    }),
    { 'paper.json': JSON.stringify(scheme('paper', 'Paper')) },
  )
  const rejected = {
    'missing-style': [{ styles: ['missing.css'] }, {}],
    'missing-theme': [{ themes: ['themes/gone.json'] }, {}],
    'oversize-theme': [
      { themes: ['big.json'] },
      {
        'big.json': JSON.stringify({
          ...scheme('big', 'Big'),
          license: { name: 'MIT', text: 'x'.repeat(70000) },
        }),
      },
    ],
    'invalid-json': [{ themes: ['broken.json'] }, { 'broken.json': '{' }],
    'invalid-theme': [
      { themes: ['wrong.json'] },
      { 'wrong.json': JSON.stringify({ id: 'wrong', colors: {} }) },
    ],
    'outside-theme': [{ themes: ['linked.json'] }, {}],
  }
  for (const [id, [fields, files]] of Object.entries(rejected))
    await writePackage(source(id), metadata(id, fields), files)
  await symlink(
    join(source('styled-addon'), 'themes/dusk.json'),
    join(source('outside-theme'), 'linked.json'),
  )

  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [globalThis.packageSource],
    })
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  const install = async (id) => {
    await app.evaluate((_electron, path) => {
      globalThis.packageSource = path
    }, source(id))
    return page.evaluate(() => window.hibi.installAddon())
  }
  for (const [id, error] of [
    ['missing-style', /needs README\.md and the entry files/],
    ['missing-theme', /needs README\.md and the entry files/],
    ['oversize-theme', /theme files must be no larger than 64 KiB/],
    ['invalid-json', /theme file broken\.json is not valid JSON/],
    ['invalid-theme', /theme file wrong\.json has an invalid color scheme/],
    ['outside-theme', /cannot contain symbolic links/],
  ])
    await assert.rejects(install(id), error, id)
  for (const id of ['styled-addon', 'fragile-addon', 'paper-theme'])
    await install(id)
  const packages = await page.evaluate(() => window.hibi.getInstalledAddons())
  assert.deepEqual(packages.map(({ manifest }) => manifest.id).sort(), [
    'fragile-addon',
    'paper-theme',
    'styled-addon',
  ])
  const styled = packages.find(({ manifest }) => manifest.id === 'styled-addon')
  const base = styled.url.replace(/index\.js$/, '')
  assert.deepEqual(styled.styles, [
    `${base}styles/base.css`,
    `${base}later.css`,
    `${base}remote.css`,
  ])
  assert.deepEqual(
    styled.themes.map(({ id }) => id),
    ['dusk', 'ember'],
  )
  assert.deepEqual(
    packages
      .find(({ manifest }) => manifest.id === 'paper-theme')
      .manifest.licenses.map(({ id }) => id),
    ['theme-paper'],
  )

  // Reload so the editor hydrates the new packages; disabled packages fetch nothing.
  await page.reload()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page.evaluate(() => {
    window.violations = []
    document.addEventListener('securitypolicyviolation', (event) =>
      window.violations.push(`${event.effectiveDirective} ${event.blockedURI}`),
    )
    for (const name of ['styled-probe', 'styled-remote']) {
      const element = document.createElement('div')
      element.className = name
      element.textContent = 'probe'
      document.body.append(element)
    }
  })
  assert.equal(
    await page.evaluate(
      async (url) => (await fetch(url)).status,
      styled.styles[0],
    ),
    403,
  )
  assert.equal(await page.locator('link[data-addon-style]').count(), 0)

  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  const toggle = async (id) => {
    const checkbox = page.locator(`#addon-${id}`)
    const next = !(await checkbox.isChecked())
    await checkbox.click()
    await page.waitForFunction(
      ([id, next]) => document.querySelector(`#addon-${id}`)?.checked === next,
      [id, next],
    )
  }
  const sheets = (owner) =>
    page.evaluate(
      (owner) =>
        [...document.querySelectorAll(`link[data-addon-style="${owner}"]`)].map(
          (link) => link.href,
        ),
      owner,
    )
  await toggle('styled-addon')
  await page.waitForFunction(
    () =>
      window.styledStarts === 1 &&
      document.querySelectorAll(
        'link[data-addon-style="styled-addon"]:not([media])',
      ).length === 3,
  )
  assert.deepEqual(await sheets('styled-addon'), styled.styles)

  const cascade = await page.evaluate(async () => {
    const sheets = [
      ...document.querySelectorAll('link[rel="stylesheet"], style'),
    ]
    const position = (selector) =>
      sheets.indexOf(document.querySelector(selector))
    const probe = getComputedStyle(document.querySelector('.styled-probe'))
    return {
      afterCore:
        position('link[rel="stylesheet"]:not([data-addon-style])') <
        position('link[data-addon-style]'),
      beforeRuntime:
        position('link[data-addon-style][data-addon-style-index="2"]') <
          position('style[data-addon-style="styled-addon.runtime"]') &&
        position('style[data-addon-style="styled-addon.runtime"]') <
          position('style[data-addon-style="styled-addon.override"]'),
      color: probe.color,
      outline: probe.outlineColor,
      decoration: probe.textDecorationColor,
      imported: probe.getPropertyValue('--styled-import').trim(),
      font: (await document.fonts.load('16px styled-font')).length,
    }
  })
  assert.deepEqual(cascade, {
    afterCore: true,
    beforeRuntime: true,
    color: 'rgb(4, 5, 6)',
    outline: 'rgb(7, 8, 9)',
    decoration: 'rgb(10, 11, 12)',
    imported: 'yes',
    font: 1,
  })
  // Relative assets resolve against the package's versioned path and load from it.
  const image = await page.evaluate(
    () =>
      getComputedStyle(document.querySelector('.styled-probe')).backgroundImage,
  )
  assert.equal(image, `url("${base}assets/dot.png")`)
  assert.equal(
    await page.evaluate(
      async (url) => (await fetch(url)).status,
      `${base}assets/dot.png`,
    ),
    200,
  )
  await page.evaluate(() =>
    document.fonts.load('16px remote-font').catch(() => {}),
  )
  await page.waitForFunction(
    () =>
      window.violations.some((entry) =>
        entry.startsWith('img-src https://example.invalid'),
      ) &&
      window.violations.some((entry) =>
        entry.startsWith('font-src https://example.invalid'),
      ),
  )

  // Declared themes follow the activation; a saved selection survives a stop.
  assert.deepEqual(
    (await page.evaluate(() => window.styledSchemes())).filter((id) =>
      id.startsWith('styled-addon.'),
    ),
    ['styled-addon.dusk', 'styled-addon.ember'],
  )
  await page.evaluate(() => window.styledUseDusk())
  await page.waitForFunction(
    () => document.documentElement.dataset.colorscheme === 'styled-addon.dusk',
  )
  await toggle('styled-addon')
  await page.waitForFunction(
    () => document.documentElement.dataset.colorscheme === 'hibi-dark',
  )
  assert.deepEqual(await sheets('styled-addon'), [])
  assert.equal(
    await page.locator('style[data-addon-style^="styled-addon."]').count(),
    0,
  )
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('hibi-colorscheme')).dark,
    ),
    'styled-addon.dusk',
  )
  await toggle('styled-addon')
  await page.waitForFunction(
    () =>
      window.styledStarts === 2 &&
      document.querySelectorAll(
        'link[data-addon-style="styled-addon"]:not([media])',
      ).length === 3,
  )
  await page.waitForFunction(
    () => document.documentElement.dataset.colorscheme === 'styled-addon.dusk',
  )
  assert.deepEqual(await sheets('styled-addon'), styled.styles)

  // Failed starts and failed sheet loads remove everything the activation attached.
  const fragileSchemes = () =>
    page.evaluate(() =>
      window.styledSchemes().filter((id) => id.startsWith('fragile-addon.')),
    )
  const fragileSheet = join(
    profile,
    'installed-addons',
    'fragile-addon',
    'b.css',
  )
  await rm(fragileSheet)
  await toggle('fragile-addon')
  await page.waitForFunction(() =>
    /fragile-addon addon could not load b\.css/i.test(document.body.innerText),
  )
  assert.deepEqual(await sheets('fragile-addon'), [])
  assert.deepEqual(await fragileSchemes(), [])
  assert.equal(await page.evaluate(() => window.fragileStarts), undefined)
  await writeFile(fragileSheet, '.fragile-probe { outline-color: red; }')
  await page.evaluate(() => localStorage.setItem('fragile-throw', '1'))
  await toggle('fragile-addon')
  await toggle('fragile-addon')
  await page.waitForFunction(() =>
    /fragile start failed/i.test(document.body.innerText),
  )
  assert.deepEqual(await sheets('fragile-addon'), [])
  assert.deepEqual(await fragileSchemes(), [])
  assert.deepEqual(await sheets('styled-addon'), styled.styles)
})

test('startup resolves recorded package resources and keeps older installs unchanged', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-package-styles-load-'))
  const packages = {
    'legacy-styles': [
      { styles: ['missing.css'], themes: [scheme('old', 'Old')] },
      {},
      undefined,
    ],
    'recorded-styles': [
      { styles: ['a.css'], themes: ['t.json'] },
      { 'a.css': '.a {}', 't.json': JSON.stringify(scheme('t', 'T')) },
      true,
    ],
    'unlisted-styles': [
      { styles: ['a.css'] },
      { 'a.css': '.a {}' },
      true,
      ['hibi-addon.json', 'index.js'],
    ],
  }
  for (const [id, [fields, files, resources, listed]] of Object.entries(
    packages,
  )) {
    const folder = join(profile, 'installed-addons', id)
    await writePackage(folder, metadata(id, fields), files)
    await writeFile(
      join(folder, '.hibi-install.json'),
      JSON.stringify({
        hash: 'a'.repeat(64),
        files: listed ?? ['hibi-addon.json', 'index.js', ...Object.keys(files)],
        source: 'local',
        resources,
      }),
    )
  }
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  const installed = await page.evaluate(() => window.hibi.getInstalledAddons())
  const find = (id) => installed.find(({ manifest }) => manifest.id === id)
  assert.equal(find('legacy-styles').styles, undefined)
  assert.deepEqual(find('legacy-styles').themes, [])
  assert.deepEqual(find('recorded-styles').styles, [
    `app://hibi/installed-addons/recorded-styles/${'a'.repeat(64)}/a.css`,
  ])
  assert.deepEqual(
    find('recorded-styles').themes.map(({ id }) => id),
    ['t'],
  )
  assert.equal(find('unlisted-styles'), undefined)
})

test('package sheets follow late core styles, apply after activation, and give up on stalled loads', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-package-styles-timing-'))
  const hash = 'b'.repeat(64)
  const packages = {
    'order-addon': [
      { styles: ['order.css'] },
      { 'order.css': '.hibi-name { font-weight: 900; }' },
    ],
    'pending-addon': [
      { styles: ['pending.css'] },
      {
        'pending.css': '.pending-probe { color: rgb(30, 31, 32); }',
        'index.js': `export default () => ({ start() {
          window.pendingStarts = (window.pendingStarts || 0) + 1;
          return new Promise((resolve, reject) => {
            window.settlePending = (error) => error ? reject(new Error(error)) : resolve();
          });
        } });`,
      },
    ],
    // Required (not background) so the document stays busy while it activates.
    'slow-addon': [
      { styles: ['fast.css', 'slow.css'], startup: undefined },
      {
        'fast.css': '.slow-probe { color: rgb(40, 41, 42); }',
        'slow.css': '.slow-probe { outline-color: rgb(40, 41, 42); }',
      },
    ],
  }
  for (const [id, [fields, files]] of Object.entries(packages)) {
    const folder = join(profile, 'installed-addons', id)
    await writePackage(folder, metadata(id, fields), files)
    await writeFile(
      join(folder, '.hibi-install.json'),
      JSON.stringify({
        hash,
        files: [
          'hibi-addon.json',
          'README.md',
          'index.js',
          ...Object.keys(files),
        ],
        source: 'local',
        resources: true,
      }),
    )
  }
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'order-addon': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()

  // Settings CSS loads with its chunk after the package sheet is already attached.
  await page.waitForFunction(
    () =>
      document.querySelector(
        'link[data-addon-style="order-addon"]:not([media])',
      )?.sheet,
  )
  assert.equal(await page.locator('.hibi-name').count(), 0)
  await clickMenu(app, 'Settings')
  await page.locator('#category-hibi').click()
  await page.locator('.hibi-name').waitFor()
  assert.deepEqual(
    await page.evaluate(() => {
      const sheets = [
        ...document.querySelectorAll('link[rel="stylesheet"], style'),
      ]
      const firstAddon = sheets.findIndex((element) =>
        element.matches('[data-addon-style]'),
      )
      const core = sheets.filter(
        (element) =>
          element.localName === 'link' &&
          !element.matches('[data-addon-style]'),
      )
      return {
        coreFirst: core.every(
          (element) => sheets.indexOf(element) < firstAddon,
        ),
        coreLoaded: core.every((element) => !!element.sheet),
        weight: getComputedStyle(document.querySelector('.hibi-name'))
          .fontWeight,
      }
    }),
    { coreFirst: true, coreLoaded: true, weight: '900' },
  )

  // Loaded sheets stay inactive until start succeeds, and never apply when it fails.
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  const toggle = async (id) => {
    const checkbox = page.locator(`#addon-${id}`)
    const next = !(await checkbox.isChecked())
    await checkbox.click()
    await page.waitForFunction(
      ([id, next]) => document.querySelector(`#addon-${id}`)?.checked === next,
      [id, next],
    )
  }
  const probe = (name) =>
    page.evaluate((name) => {
      let element = document.querySelector(`.${name}`)
      if (!element) {
        element = document.createElement('div')
        element.className = name
        document.body.append(element)
      }
      return getComputedStyle(element).color
    }, name)
  const loaded = (owner) =>
    page.evaluate(
      (owner) =>
        [...document.querySelectorAll(`link[data-addon-style="${owner}"]`)].map(
          (link) => !!link.sheet,
        ),
      owner,
    )
  const baseline = await probe('pending-probe')
  await toggle('pending-addon')
  await page.waitForFunction(
    () =>
      window.settlePending &&
      document.querySelector('link[data-addon-style="pending-addon"]')?.sheet,
  )
  assert.equal(await probe('pending-probe'), baseline)
  await page.evaluate(() => window.settlePending())
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.pending-probe')).color ===
      'rgb(30, 31, 32)',
  )
  await toggle('pending-addon')
  assert.deepEqual(await loaded('pending-addon'), [])
  await toggle('pending-addon')
  await page.waitForFunction(
    () =>
      window.pendingStarts === 2 &&
      document.querySelector('link[data-addon-style="pending-addon"]')?.sheet,
  )
  assert.equal(await probe('pending-probe'), baseline)
  await page.evaluate(() => window.settlePending('pending start rejected'))
  await page.waitForFunction(() =>
    /pending start rejected/i.test(document.body.innerText),
  )
  assert.deepEqual(await loaded('pending-addon'), [])
  assert.equal(await probe('pending-probe'), baseline)

  // A stalled sheet fails the activation at its deadline; its late response adds nothing.
  await app.evaluate(() => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const lstat = fs.lstat
    globalThis.slowCss = new Promise((resolve) => {
      globalThis.releaseSlowCss = resolve
    })
    fs.lstat = async (path, ...rest) => {
      if (String(path).endsWith('slow.css')) await globalThis.slowCss
      return lstat(path, ...rest)
    }
    process.getBuiltinModule('node:module').syncBuiltinESMExports()
  })
  const slowBaseline = await probe('slow-probe')
  await toggle('slow-addon')
  await page.waitForFunction(
    () =>
      document.querySelector(
        'link[data-addon-style="slow-addon"][data-addon-style-index="0"]',
      )?.sheet,
  )
  assert.deepEqual(await loaded('slow-addon'), [true, false])
  assert.equal(await probe('slow-probe'), slowBaseline)
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  // Waits past the 5 s sheet deadline in src/renderer/src/addon-sheets.ts.
  await page.waitForFunction(
    () =>
      /slow-addon addon could not load slow\.css/i.test(
        document.body.innerText,
      ),
    undefined,
    { timeout: 15000 },
  )
  await page.waitForFunction(
    () => !document.querySelector('[inert][aria-busy="true"]'),
  )
  assert.deepEqual(await loaded('slow-addon'), [])
  await app.evaluate(() => globalThis.releaseSlowCss())
  await page.evaluate(
    (url) => fetch(url).catch(() => {}),
    `app://hibi/installed-addons/slow-addon/${hash}/slow.css`,
  )
  assert.deepEqual(await loaded('slow-addon'), [])
  assert.equal(await probe('slow-probe'), slowBaseline)
})
