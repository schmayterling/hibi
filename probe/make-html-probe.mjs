// Writes tests/zz-pick-html-probe.test.mjs: editor-input whose clipboardAfter
// also logs every cut/copy event the page sees (data at window bubble) and a
// timed series of host clipboard reads for 1500 ms. Assertions unchanged.
// Throwaway diagnostic, never merged.
import { readFileSync, writeFileSync } from 'node:fs'
const dir = process.argv[2]
let s = readFileSync(dir + '/tests/editor-input.test.mjs', 'utf8')
const swap = (from, to) => {
  if (!s.includes(from)) throw new Error('missing: ' + from.slice(0, 80))
  s = s.split(from).join(to)
}
swap(
  `    if (menu)
      await app.evaluate(
        ({ BrowserWindow }, key) =>
          BrowserWindow.getAllWindows()[0].webContents[key](),
        key === 'x' ? 'cut' : 'copy',
      )
    else await page.keyboard.press('ControlOrMeta+' + key)
    const read = () =>`,
  `    await page.evaluate(() => {
      window.probeEvents = []
      if (window.probeInstalled) return
      window.probeInstalled = true
      const log = (phase) => (event) => {
        const data = event.clipboardData
        window.probeEvents.push({
          at: Date.now(),
          type: event.type,
          phase,
          trusted: event.isTrusted,
          prevented: event.defaultPrevented,
          active: navigator.userActivation.isActive,
          types: data ? [...data.types] : null,
          text: data?.getData('text/plain').length ?? null,
          html: data?.getData('text/html').length ?? null,
        })
      }
      for (const type of ['cut', 'copy']) {
        window.addEventListener(type, log('capture'), true)
        window.addEventListener(type, log('bubble'))
      }
    })
    const started = Date.now()
    const pressing = menu ? null : page.keyboard.press('ControlOrMeta+' + key)
    const reads = await app.evaluate(
      async ({ BrowserWindow, clipboard }, { menu, key, sentinel }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents
        if (menu) contents[key === 'x' ? 'cut' : 'copy']()
        const reads = []
        const end = Date.now() + 800
        let last = ''
        while (Date.now() < end) {
          const at = Date.now()
          const [item] = await clipboard.read()
          const text = item?.types.includes('text/plain')
            ? await (await item.getType('text/plain')).text()
            : null
          const html = item?.types.includes('text/html')
            ? await (await item.getType('text/html')).text()
            : null
          let formats = null
          try {
            formats = clipboard.availableFormats()
          } catch {}
          const row = JSON.stringify({
            types: item?.types ?? null,
            text: text === sentinel ? 'sentinel' : text?.length ?? null,
            html: html?.length ?? null,
            formats,
          })
          if (row !== last) reads.push({ at, ...JSON.parse(row) })
          last = row
        }
        return reads
      },
      { menu, key, sentinel },
    ).catch((error) => [{ error: String(error) }])
    await pressing
    const events = await page.evaluate(() => window.probeEvents)
    console.log(
      '# htmlprobe ' +
        JSON.stringify({
          key,
          menu,
          started,
          events: events.map((e) => ({ ...e, at: e.at - started })),
          reads: reads.map((r) => ({ ...r, at: r.at - started })),
        }),
    )
    const read = () =>`,
)
swap("cut over a native table pick copies as copy does and deletes as Delete does', {\n  timeout: 240000,", "cut over a native table pick copies as copy does and deletes as Delete does', {\n  timeout: 900000,")
writeFileSync(dir + '/tests/zz-pick-html-probe.test.mjs', s)
