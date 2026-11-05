import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron } from '../tests/electron.mjs'

const count = Number(process.argv[2] ?? 10000)
if (![1000, 10000, 100000].includes(count))
  throw Error('Choose 1000, 10000 or 100000 sidebar rows.')
const profile = await mkdtemp(join(tmpdir(), 'hibi-sidebar-bench-'))
const addon = join(profile, 'installed-addons', 'sidebar-bench')
await mkdir(addon, { recursive: true })
await writeFile(
  join(addon, 'hibi-addon.json'),
  JSON.stringify({
    id: 'sidebar-bench',
    name: 'Sidebar benchmark',
    description: 'Shared sidebar rendering benchmark',
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
  JSON.stringify({ 'sidebar-bench': true }),
)
await writeFile(
  join(addon, 'index.js'),
  `export default sdk => ({ start(context) {
  const h = sdk.React.createElement;
  const fixture = window.sidebarBench = { count: ${count} };
  const items = Array.from({length: ${count}}, (_, index) => ({
    id: 'row-' + index, label: 'node ' + index,
    ...(index % 100 === 0 ? {section: 'section ' + index / 100} : {}),
  }));
  function Content() {
    const [selected, select] = sdk.React.useState('row-0');
    sdk.React.useLayoutEffect(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const root = document.querySelector('.benchmark-sidebar');
        const scroll = root.querySelector('.sidebar-scroll');
        const height = scroll.clientHeight;
        fixture.result = { requested: fixture.count, elapsedMs: performance.now() - fixture.started,
          rows: root.querySelectorAll('.sidebar-row').length, nodes: root.querySelectorAll('*').length,
          viewportHeight: height, scrollHeight: scroll.scrollHeight };
      }));
    }, []);
    return h('div', {style:{height:600,display:'flex'}}, h(sdk.ui.Sidebar, {
      items, selected, onSelect:select, collapsible:false, label:'Benchmark tree', className:'benchmark-sidebar',
    }));
  }
  const handle = context.views.register({ id:'tree', label:'Sidebar benchmark', side:'right', Content });
  fixture.open = () => { fixture.started = performance.now(); handle.open(); };
}});`,
)
const app = await electron.launch({
  args: [resolve('.'), `--user-data-dir=${profile}`],
})
const watchdog = setTimeout(() => app.process().kill('SIGKILL'), 45000)
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .waitFor()
  await page.waitForFunction(
    () => typeof window.sidebarBench?.open === 'function',
  )
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => window.sidebarBench.open())
  await page.waitForFunction(() => !!window.sidebarBench.result)
  console.log(
    JSON.stringify(
      await page.evaluate(() => ({
        ...window.sidebarBench.result,
        userAgent: navigator.userAgent,
        devicePixelRatio,
        viewport: { width: innerWidth, height: innerHeight },
      })),
      null,
      2,
    ),
  )
} catch (error) {
  console.log(
    JSON.stringify({ requested: count, failed: String(error) }, null, 2),
  )
  process.exitCode = 1
} finally {
  await app.close().catch(() => app.process().kill('SIGKILL'))
  clearTimeout(watchdog)
  await rm(profile, { recursive: true, force: true })
}
