import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

for (const [mode, cascade] of [
  ['source', false],
  ['formatted', false],
  ['source', true],
  ['formatted', true],
]) {
  for (const newline of ['\n', '\r\n']) {
    test(`${mode} ${cascade ? 'parser and props' : 'parser'} failure retains ${newline === '\n' ? 'lf' : 'crlf'} typing, undo, and unrelated registrations`, {
      timeout: 90000,
    }, async (t) => {
      const folder = await mkdtemp(join(tmpdir(), 'hibi-parser-fault-'))
      const profile = join(folder, 'profile')
      const file = join(folder, 'note.md')
      const source = [
        '# Title',
        '',
        '**strong** and ==proof== and @healthy@',
        '',
        '| head |',
        '| --- |',
        '| cell |',
        '',
      ].join(newline)
      await writeFile(file, source)
      const directory = join(profile, 'installed-addons', 'parser-proof')
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'hibi-addon.json'),
        JSON.stringify({
          id: 'parser-proof',
          name: 'Parser proof',
          description: 'Parser fixture',
          apiVersion: 3,
          capabilities: ['formatted', 'source'],
          version: '1.0.0',
          kind: 'extension',
          authors: [{ displayName: 'Test' }],
          entry: 'index.js',
        }),
      )
      await writeFile(
        join(directory, '.hibi-install.json'),
        JSON.stringify({
          hash: 'a'.repeat(64),
          files: ['hibi-addon.json', 'index.js'],
          source: 'local',
        }),
      )
      await writeFile(
        join(directory, 'index.js'),
        `export default sdk => ({ start(context) {
        const delimiter = {resolve:'Proof',mark:'ProofMark'}
        let old
        if (${cascade}) context.editor.registerFlavor({id:'props',name:'Props',kind:'syntax',description:'Proof',detect:()=>true,
          syntax:{props:[()=>{if(window.propsArmed){window.propFailures=(window.propFailures||0)+1;throw Error('props proof failure')}return null}]}})
        const flavor = () => ({id:'bad',name:'Bad',kind:'syntax',description:'Proof',detect:()=>true,
          syntax:{defineNodes:['Proof','ProofMark','Partial'],parseInline:[{name:'Proof',before:'Escape',parse(cx,next,pos){
            if(window.throwNow){window.parseFailures=(window.parseFailures||0)+1;window.propsArmed=${cascade};cx.addElement(cx.elt('Partial',pos,pos+1));throw Error('parser proof failure')}
            if(next!==61||cx.char(pos+1)!==61)return -1
            return cx.addDelimiter(delimiter,pos,pos+2,true,true)
          }}]},render:[{nodes:['Proof'],decorate(node,out){out.mark(node.from+2,node.to-2,{class:'fault-proof'})}},{nodes:['Partial'],decorate(node,out){out.mark(node.from,node.to,{class:'partial-proof'})}}]})
        old=context.editor.registerFlavor(flavor())
        const healthyDelimiter = {resolve:'Healthy',mark:'HealthyMark'}
        context.editor.registerFlavor({id:'healthy',name:'Healthy',kind:'syntax',description:'Proof',detect:()=>true,
          syntax:{defineNodes:['Healthy','HealthyMark'],parseInline:[{name:'Healthy',parse(cx,next,pos){
            if(next!==64)return -1
            return cx.addDelimiter(healthyDelimiter,pos,pos+1,true,true)
          }}],wrap:inner=>({advance:()=>inner.advance(),stopAt:pos=>inner.stopAt(pos),get parsedPos(){return inner.parsedPos},get stoppedAt(){return inner.stoppedAt}})},
          render:[{nodes:['Healthy'],decorate(node,out){out.mark(node.from+1,node.to-1,{class:'healthy-proof'})}}]})
        context.editor.registerFormatted({id:'view',create(){return sdk.codeMirror.view.EditorView.editorAttributes.of({'data-parser-view':'yes'})}})
        context.editor.registerSource({id:'view',create(){return sdk.codeMirror.view.EditorView.editorAttributes.of({'data-parser-view':'yes'})}})
        window.replaceParser=()=>{window.throwNow=false;old();window.removeReplacement=context.editor.registerFlavor(flavor());old();old()}
        window.removeParser=()=>window.removeReplacement()
      }})`,
      )
      await writeFile(
        join(profile, 'addons.json'),
        JSON.stringify({ 'parser-proof': true }),
      )
      const app = await electron.launch({
        args: [resolve('.'), `--user-data-dir=${profile}`],
      })
      t.after(async () => {
        await app.evaluate(({ dialog }) => {
          dialog.showMessageBox = async () => ({ response: 1 })
        })
        await app.close()
        await rm(folder, { recursive: true, force: true })
      })
      const page = await app.firstWindow()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await waitForDocumentEditor(app, page)
      await page.evaluate(() =>
        localStorage.setItem('hibi:formatted-engine', 'codemirror'),
      )
      await page.reload()
      await waitForDocumentEditor(app, page)
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [path],
        })
      }, file)
      await pressShortcut(app, `${mod}+o`)
      await page.locator('.rich-pane .fault-proof').waitFor()
      await page.locator('.rich-pane .healthy-proof').waitFor()
      await page.locator('.rich-pane table').waitFor()
      if (mode === 'source')
        await page
          .getByRole('button', { name: 'Source view', exact: true })
          .click()
      const selector =
        mode === 'source'
          ? '.source-pane .cm-content'
          : '.rich-pane .cm-content'
      await page
        .locator(
          (mode === 'source' ? '.source-pane' : '.rich-pane') +
            ' [data-parser-view] .cm-content',
        )
        .waitFor()
      await waitForAsync(
        page,
        async (expected) =>
          (await window.hibi.getDocument()).markdown === expected,
        source,
      )
      // Renderer focus stays inside a hidden test window.
      const session = await page.context().newCDPSession(page)
      await session.send('Emulation.setFocusEmulationEnabled', {
        enabled: true,
      })
      const at = await page.evaluate((selector) => {
        const view = document.querySelector(selector).cmTile.root.view
        const at = view.state.doc.toString().indexOf('proof') + 1
        view.dispatch({ selection: { anchor: at } })
        view.focus()
        window.throwNow = true
        return at
      }, selector)
      await page.keyboard.insertText('z')
      const expected = source.replace('proof', 'pzroof')
      t.diagnostic(
        JSON.stringify(
          await page.evaluate(async () => ({
            canonical: (await window.hibi.getDocument()).markdown,
            failures: window.parseFailures ?? 0,
          })),
        ),
      )
      await waitForAsync(
        page,
        async (expected) =>
          (await window.hibi.getDocument()).markdown === expected,
        expected,
      )
      await page.waitForFunction(() => window.parseFailures === 1)
      await page
        .locator('.toast')
        .filter({ hasText: 'parser-proof.bad: parser proof failure' })
        .waitFor()
      assert.equal(await page.evaluate(() => window.parseFailures), 1)
      assert.equal(
        await page.evaluate(() => window.propFailures ?? 0),
        Number(cascade),
      )
      assert.equal(
        await page.evaluate(
          (selector) =>
            document.querySelector(selector).cmTile.root.view.state.selection
              .main.head,
          selector,
        ),
        at + 1,
      )
      if (cascade)
        await page
          .locator('.toast')
          .filter({ hasText: 'parser-proof.props: props proof failure' })
          .waitFor()
      assert.deepEqual(errors, [])
      await pressShortcut(app, `${mod}+z`)
      await waitForAsync(
        page,
        async (expected) =>
          (await window.hibi.getDocument()).markdown === expected,
        source,
      )
      await pressShortcut(
        app,
        process.platform === 'win32' ? 'Control+y' : `${mod}+Shift+z`,
      )
      await waitForAsync(
        page,
        async (expected) =>
          (await window.hibi.getDocument()).markdown === expected,
        expected,
      )
      if (mode === 'source')
        await page.getByRole('button', { name: 'normal', exact: true }).click()
      await page.locator('.rich-pane .healthy-proof').waitFor()
      await page.locator('.rich-pane .hibi-lp-strong').waitFor()
      await page.locator('.rich-pane table').waitFor()
      assert.equal(await page.locator('.fault-proof,.partial-proof').count(), 0)
      await page.evaluate(() => window.replaceParser())
      await page.locator('.rich-pane .fault-proof').waitFor()
      assert.equal(await page.evaluate(() => window.parseFailures), 1)
      await page.evaluate(() => window.removeParser())
      await page
        .locator('.rich-pane .fault-proof')
        .waitFor({ state: 'detached' })
      await page.locator('.rich-pane .healthy-proof').waitFor()
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).markdown,
        expected,
      )
      assert.deepEqual(errors, [])
    })
  }
}
