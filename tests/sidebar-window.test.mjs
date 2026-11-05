import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'

test('large sidebar preserves focus, rename, anchors and section geometry with bounded DOM', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-sidebar-window-'))
  const addon = join(profile, 'installed-addons', 'sidebar-window')
  await mkdir(addon, { recursive: true })
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'sidebar-window',
      name: 'Sidebar window',
      description: 'Tree fixture',
      kind: 'extension',
      version: '1.0.0',
      apiVersion: 3,
      authors: [{ displayName: 'Test' }],
      capabilities: ['ui'],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['index.js', 'hibi-addon.json'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'sidebar-window': true }),
  )
  await writeFile(
    join(addon, 'index.js'),
    `export default sdk => ({ start(context) {
    const h = sdk.React.createElement;
    const fixture = window.sidebarFixture = { commits: [], moves: [] };
    const Resize = window.ResizeObserver;
    window.ResizeObserver = class extends Resize {
      constructor(callback) {
        super((entries, observer) => {
          if (fixture.pauseMeasurements && entries.some(entry => entry.target.matches('.sidebar-metrics > span')))
            fixture.pendingMeasurement = () => callback(entries, observer);
          else callback(entries, observer);
        });
      }
    };
    fixture.flushMeasurements = () => {
      fixture.pauseMeasurements = false;
      fixture.pendingMeasurement?.();
      fixture.pendingMeasurement = null;
    };
    const rows = count => Array.from({length:count}, (_, index) => ({
      id:'row-'+index, label:'node '+index+'.md',
      ...(index % 100 === 0 ? {section:'section '+index/100} : {}),
    }));
    function Content() {
      const [items, setItems] = sdk.React.useState(() => rows(10000));
      const [selected, select] = sdk.React.useState('row-0');
      const [editing, edit] = sdk.React.useState(null);
      fixture.select = select;
      fixture.resize = count => setItems(rows(count));
      fixture.prepend = () => setItems(old => [{id:'new',label:'new'}, ...old]);
      fixture.removeFirst = () => setItems(old => old.slice(1));
      fixture.nest = () => setItems([{id:'folder',label:'folder',children:rows(10000)}]);
      fixture.rename = id => edit({id,value:'renamed.md'});
      return h('div', {style:{height:600,display:'flex'}}, h(sdk.ui.Sidebar, {
        items, selected, onSelect:select, label:'Windowed tree', className:'windowed-fixture',
        onMenu:(id, anchor) => { fixture.menu = {id, anchor}; },
        onMove:(id, parent) => fixture.moves.push({id,parent}),
        editing:editing && {...editing, disabled:false,
          onChange:value => edit(old => ({...old,value})),
          onCommit:() => {fixture.commits.push(editing); edit(null);},
          onCancel:() => edit(null),
        },
      }));
    }
    const handle = context.views.register({id:'tree',label:'Windowed tree',side:'right',Content});
    fixture.open = () => handle.open();
  }});`,
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
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .waitFor()
  await page.waitForFunction(
    () => typeof window.sidebarFixture?.open === 'function',
  )
  await page.evaluate(() => window.sidebarFixture.open())
  const tree = page.locator('.windowed-fixture')
  const scroll = tree.locator('.sidebar-scroll')
  const row = (id) => tree.locator(`[role="treeitem"][id="sidebar-${id}"]`)
  const bounded = async () =>
    assert.ok((await tree.locator('.sidebar-row').count()) < 60)
  const focus = async (id) => {
    await page.waitForFunction(
      (id) => document.activeElement?.id === `sidebar-${id}`,
      id,
    )
    const bounds = await row(id).boundingBox()
    const viewport = await scroll.boundingBox()
    assert.ok(
      bounds.y >= viewport.y - 1 &&
        bounds.y + bounds.height <= viewport.y + viewport.height + 1,
    )
    await bounded()
  }
  await row('row-0').waitFor()
  await bounded()
  assert.equal(await row('row-0').getAttribute('aria-setsize'), '10000')
  await row('row-0').focus()
  await page.keyboard.press('End')
  await focus('row-9999')
  assert.equal(await row('row-9999').getAttribute('aria-posinset'), '10000')
  await page.keyboard.press('ArrowUp')
  await focus('row-9998')
  await page.keyboard.press('Home')
  await focus('row-0')
  await page.evaluate(() => window.sidebarFixture.resize(100000))
  await page.waitForFunction(
    () =>
      document.querySelector('#sidebar-row-0')?.getAttribute('aria-setsize') ===
      '100000',
  )
  await page.keyboard.press('End')
  await focus('row-99999')
  assert.equal(
    await scroll.evaluate((element) => element.scrollHeight),
    2836000,
  )

  // Geometry follows public tokens, including exported sites' larger touch rows.
  await tree.evaluate((element) =>
    element.style.setProperty('--sidebar-row-height', '44px'),
  )
  await page.waitForFunction(
    () =>
      document.querySelector('.windowed-fixture .sidebar-row')?.offsetHeight ===
      44,
  )
  await page.keyboard.press('Home')
  await focus('row-0')
  await page.keyboard.press('End')
  await focus('row-99999')
  assert.equal(
    await scroll.evaluate((element) => element.scrollHeight),
    4436000,
  )
  await tree.evaluate((element) => {
    window.sidebarFixture.pauseMeasurements = true
    element.style.removeProperty('--sidebar-row-height')
  })
  await page.waitForFunction(
    () =>
      document.querySelector('.windowed-fixture .sidebar-row')?.offsetHeight ===
      28,
  )

  await page.evaluate(() => window.sidebarFixture.select('row-50000'))
  await row('row-50000').focus()
  await focus('row-50000')
  await page.evaluate(() => window.sidebarFixture.flushMeasurements())
  await focus('row-50000')
  const anchorBefore = await row('row-50000').boundingBox()
  await page.evaluate(() => window.sidebarFixture.prepend())
  await page.waitForFunction(
    () =>
      document
        .querySelector('#sidebar-row-50000')
        ?.getAttribute('aria-posinset') === '50002',
  )
  assert.equal((await row('row-50000').boundingBox()).y, anchorBefore.y)
  await page.evaluate(() => window.sidebarFixture.removeFirst())
  await page.waitForFunction(
    () =>
      document
        .querySelector('#sidebar-row-50000')
        ?.getAttribute('aria-posinset') === '50001',
  )
  assert.equal((await row('row-50000').boundingBox()).y, anchorBefore.y)
  await page.waitForFunction(() => {
    const root = document.querySelector('.windowed-fixture')
    return (
      Math.abs(
        root.querySelector('.sidebar-selection').getBoundingClientRect().y -
          root.querySelector('#sidebar-row-50000').getBoundingClientRect().y,
      ) < 1
    )
  })

  await page.evaluate(() => window.sidebarFixture.rename('row-80000'))
  const rename = tree.getByRole('textbox', { name: 'Rename item' })
  await rename.waitFor()
  assert.deepEqual(
    await rename.evaluate((element) => ({
      focused: document.activeElement === element,
      start: element.selectionStart,
      end: element.selectionEnd,
    })),
    { focused: true, start: 0, end: 7 },
  )
  await rename.fill('changed.md')
  await scroll.evaluate((element) => {
    element.scrollTop = 0
  })
  await row('row-0').waitFor()
  assert.equal(await rename.count(), 1)
  assert.equal(
    await rename.evaluate((element) => document.activeElement === element),
    true,
  )
  await row('row-0').click()
  await page.waitForFunction(() => window.sidebarFixture.commits.length === 1)
  assert.deepEqual(await page.evaluate(() => window.sidebarFixture.commits), [
    { id: 'row-80000', value: 'changed.md' },
  ])
  await bounded()

  // Menu anchors and drag sources remain connected while their viewport scrolls away.
  await row('row-0').click({ button: 'right' })
  await scroll.evaluate((element) => {
    element.scrollTop = 28000
  })
  await row('row-990').waitFor()
  assert.equal(
    await page.evaluate(() => window.sidebarFixture.menu.anchor.isConnected),
    true,
  )
  await row('row-990').dispatchEvent('dragstart', {
    dataTransfer: await page.evaluateHandle(() => new DataTransfer()),
  })
  await scroll.evaluate((element) => {
    element.scrollTop = 56000
  })
  await row('row-1980').waitFor()
  assert.equal(await row('row-990').count(), 1)
  await row('row-990').dispatchEvent('dragend')
  await page.waitForFunction(() => !document.querySelector('#sidebar-row-990'))

  await page.evaluate(() => {
    window.sidebarFixture.select('row-5000')
    window.sidebarFixture.nest()
  })
  await row('row-5000').focus()
  await focus('row-5000')
  assert.equal(await row('row-5000').getAttribute('aria-level'), '2')
  assert.equal(await row('row-5000').getAttribute('aria-setsize'), '10000')
  await page.keyboard.press('ArrowLeft')
  await focus('folder')
  await page.keyboard.press('ArrowLeft')
  await page.waitForFunction(
    () =>
      document
        .querySelector('#sidebar-folder')
        ?.getAttribute('aria-expanded') === 'false',
  )
  assert.equal(await tree.locator('.sidebar-row').count(), 1)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await focus('row-0')
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/sidebar-window.png' })
})
