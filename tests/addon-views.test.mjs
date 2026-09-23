import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, replaceRichText } from './keyboard.mjs'

test('scoped views preserve sessions, pin documents, contain lazy failures, and revoke handles', {
  timeout: 40000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-views-'))
  const directory = join(profile, 'installed-addons', 'view-fixture')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'hibi-addon.json'),
    JSON.stringify({
      id: 'view-fixture',
      name: 'View fixture',
      description: 'Scoped view fixture',
      kind: 'extension',
      authors: [{ displayName: 'Test' }],
      apiVersion: 2,
      version: '1.0.0',
      capabilities: ['ui'],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(directory, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['index.js', 'hibi-addon.json'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'view-fixture': true }),
  )
  await writeFile(
    join(directory, 'index.js'),
    `export default ({ React }) => ({ start(context) {
    const h = React.createElement;
    function Content(props) {
      const [count, setCount] = React.useState(0);
      window.viewProps ??= {}; window.viewProps[props.instanceId] = props;
      return h('div', null, h('p', {className:'bound-text'}, props.document?.markdown),
        h('button', {onClick:() => setCount(count + 1)}, 'Count ' + count));
    }
    const panel = context.views.register({ id:'panel', label:'Fixture panel', location:'panel', lifetime:'session', Content });
    const staged = panel.open({id:'staged'});
    if (panel.open({id:'staged'}) !== staged) throw Error('staged instance was not reused');
    staged.hide();
    const follow = context.views.register({ id:'follow', label:'Following view', Content });
    const right = context.views.register({ id:'right', label:'Right session', side:'right', lifetime:'session', Content });
    const tab = context.views.register({ id:'tab', label:'Fixture tab', location:'tab', lifetime:'session', Content });
    const queuedRight = right.open({id:'queued'});
    if (right.open({id:'queued'}) !== queuedRight) throw Error('right staged instance was not reused');
    queuedRight.hide();
    const lazy = React.lazy(() => new Promise(resolve => { window.finishView = () => resolve({default:Content}); }));
    const slow = context.views.register({ id:'slow', label:'Slow panel', location:'panel', Content:lazy });
    const broken = context.views.register({ id:'broken', label:'Broken panel', location:'panel', Content() { throw Error('view failure'); } });
    const start = context.views.register({ id:'start', label:'Fixture start', location:'start', Content() { return h('h2', null, 'Fixture start'); } });
    window.viewsFixture = { context, panel, follow, right, tab, queuedRight, slow, broken, start, staged, handles: {} };
  }});`,
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const editor = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await page.waitForFunction(() => window.viewsFixture)
  const start = page.getByRole('region', { name: 'Start writing' })
  await start.getByRole('heading', { name: 'Fixture start' }).waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabs.length,
    0,
  )
  await replaceRichText(page, editor, 'first document')
  await start.waitFor({ state: 'hidden' })
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabs.length,
    1,
  )
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  await page.locator('.document-tab .tab-close').click()
  await start.getByRole('heading', { name: 'Fixture start' }).waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabs.length,
    0,
  )
  await page.evaluate(() => window.viewsFixture.start.dispose())
  await start.getByRole('heading', { name: 'Start typing' }).waitFor()
  await replaceRichText(page, editor, 'first document')
  await page.evaluate(() => window.viewsFixture.staged.show())
  await page
    .getByRole('region', { name: 'Fixture panel' })
    .getByRole('button', { name: 'Count 0' })
    .waitFor()
  await page.evaluate(() => window.viewsFixture.staged.close())
  const first = await page.evaluate(() => {
    const f = window.viewsFixture
    f.handles.pinned = f.panel.open({ id: 'first', binding: 'pinned' })
    return f.context.editor.getDocument().tabId
  })
  const panel = page.getByRole('region', { name: 'Fixture panel' })
  await panel.getByRole('button', { name: 'Count 0' }).click()
  await page.evaluate(() => window.viewsFixture.handles.pinned.hide())
  await panel.waitFor({ state: 'hidden' })
  await page.evaluate(() => window.viewsFixture.handles.pinned.show())
  await panel.getByRole('button', { name: 'Count 1' }).waitFor()
  await page.evaluate(() => {
    window.viewsFixture.handles.follow = window.viewsFixture.follow.open()
  })
  await clickMenu(app, 'New')
  await page.waitForFunction(
    (id) => window.viewsFixture.context.editor.getDocument().tabId !== id,
    first,
  )
  await replaceRichText(page, editor, 'second document')
  assert.equal(
    await panel.locator('.bound-text').textContent(),
    'first document',
  )
  const sidebar = page.getByRole('complementary', { name: 'Following view' })
  await page.waitForFunction(
    () =>
      document.querySelector('.addon-sidebar .bound-text')?.textContent ===
      'second document',
  )
  const focused = await page.evaluate(() =>
    window.viewProps['view-fixture.panel:first'].focusDocument(),
  )
  assert.equal(focused, true)
  await page.waitForFunction(
    (id) => window.viewsFixture.context.editor.getDocument().tabId === id,
    first,
  )
  assert.equal(await editor.textContent(), 'first document')
  await page.evaluate(() => {
    window.viewsFixture.handles.slow = window.viewsFixture.slow.open()
  })
  await page.getByText('Loading view…', { exact: true }).waitFor()
  await replaceRichText(page, editor, 'still editable')
  assert.equal(await editor.textContent(), 'still editable')
  await page.evaluate(() => window.finishView())
  await page
    .getByRole('region', { name: 'Slow panel' })
    .getByRole('button', { name: 'Count 0' })
    .waitFor()
  await page.evaluate(() => window.viewsFixture.broken.open())
  await page
    .getByRole('alert')
    .filter({ hasText: 'Could not load this view.' })
    .waitFor()
  assert.equal(await editor.getAttribute('contenteditable'), 'true')
  await page.evaluate(() => window.viewsFixture.handles.pinned.show())
  assert.equal(
    await panel.locator('.bound-text').textContent(),
    'first document',
  )
  await page.evaluate(() => window.viewsFixture.panel.dispose())
  await panel.waitFor({ state: 'hidden' })
  await page.evaluate(() => window.viewsFixture.handles.pinned.show())
  assert.equal(await page.locator('.addon-panel:not([hidden])').count(), 0)
  await page.evaluate(() => window.viewsFixture.queuedRight.show())
  const right = page.locator('.addon-sidebar[data-side="right"]')
  await right.getByRole('button', { name: 'Count 0' }).click()
  assert.equal(await sidebar.isVisible(), true)
  assert.equal(
    await page.evaluate(() => window.viewsFixture.queuedRight.id),
    'view-fixture.right:right:queued',
  )
  await page
    .getByRole('button', { name: 'Toggle right sidebar', exact: true })
    .click()
  await right.waitFor({ state: 'hidden' })
  await page.evaluate(() => window.viewsFixture.queuedRight.show())
  await right.getByRole('button', { name: 'Count 1' }).waitFor()
  await page.evaluate(() => {
    window.viewsFixture.handles.rightFollow = window.viewsFixture.follow.open({
      side: 'right',
    })
  })
  assert.equal(
    await page
      .locator('.addon-sidebar[data-side="left"]')
      .getByRole('button', { name: 'Count 0' })
      .isVisible(),
    true,
  )
  await right.getByRole('button', { name: 'Count 0' }).waitFor()
  await page.evaluate(() => window.viewsFixture.handles.rightFollow.hide())
  assert.equal(await page.locator('.app').getAttribute('data-sidebar'), 'true')
  assert.equal(
    await page.locator('.app').getAttribute('data-right-sidebar'),
    'false',
  )
  await page.evaluate(() => window.viewsFixture.queuedRight.show())
  await right.getByRole('button', { name: 'Count 1' }).waitFor()
  await page.evaluate(() => {
    const f = window.viewsFixture
    f.handles.tab = f.tab.open({ id: 'dashboard' })
  })
  const addonTab = page.getByRole('tab', { name: 'Fixture tab' })
  const tabContent = page.getByRole('tabpanel', { name: 'Fixture tab' })
  await tabContent.getByRole('button', { name: 'Count 0' }).click()
  assert.equal(await addonTab.getAttribute('aria-selected'), 'true')
  assert.equal(await editor.isVisible(), false)
  await page.locator(`#document-tab-${first}`).click()
  assert.equal(await editor.isVisible(), true)
  await addonTab.click()
  await tabContent.getByRole('button', { name: 'Count 1' }).waitFor()
  await addonTab.focus()
  await page.keyboard.press('ArrowLeft')
  await page
    .getByRole('tab', { name: 'Fixture tab', selected: false })
    .waitFor()
  await page
    .locator(
      '[role="tab"][id^="document-tab-"][aria-selected="true"][aria-disabled="false"]',
    )
    .waitFor()
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('role') === 'tab' &&
      document.activeElement.getAttribute('aria-selected') === 'true',
  )
  await page.keyboard.press('End')
  await page.getByRole('tab', { name: 'Fixture tab', selected: true }).waitFor()
  await clickMenu(app, 'Close tab')
  await addonTab.waitFor({ state: 'detached' })
  assert.equal(await editor.isVisible(), true)
  await page.locator(`#document-tab-${first}`).click()
  await page.evaluate(() => {
    window.viewsFixture.handles.tab = window.viewsFixture.tab.open({
      id: 'dashboard',
    })
  })
  await tabContent.getByRole('button', { name: 'Count 0' }).waitFor()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addons', exact: true }).click()
  await page.locator('#addon-view-fixture').click()
  await page.waitForFunction(
    () => document.querySelector('#addon-view-fixture')?.checked === false,
  )
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  assert.equal(await page.locator('[data-addon-view]').count(), 0)
  assert.equal(await addonTab.count(), 0)
  assert.equal(await editor.textContent(), 'still editable')
  assert.equal(await sidebar.count(), 0)
  await page.getByText(/no view selected/i).waitFor()
})
