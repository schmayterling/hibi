const { Plugin, requestUrl } = require('obsidian')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { EventEmitter } = require('events')
const { Readable } = require('stream')
const { Buffer } = require('buffer')
const { URL } = require('url')
const { promisify } = require('util')
const electron = require('electron')
const remote = require('@electron/remote')

module.exports = class DesktopFixture extends Plugin {
  async onload() {
    const data = await this.loadData()
    this.outside = data.outside
    const file = path.join(data.outside, 'desktop.txt')
    fs.writeFileSync(file, 'desktop fixture')
    const bytes = fs.readFileSync(file)
    const emitter = new EventEmitter()
    let event = 0
    emitter.once('fixture', (value) => {
      event = value
    })
    emitter.emit('fixture', 7)
    const chunks = []
    const stream = Readable.from([bytes])
    for await (const chunk of stream) chunks.push(chunk)
    await fsp.writeFile(
      path.join(data.outside, 'async.txt'),
      Buffer.concat(chunks),
    )
    const output = execFileSync(
      process.platform === 'win32' ? 'cmd.exe' : '/usr/bin/printf',
      process.platform === 'win32'
        ? ['/d', '/s', '/c', 'echo fixture']
        : ['fixture'],
      { encoding: 'utf8' },
    ).trim()
    if (!data.skipExternal)
      await electron.shell.openExternal('https://example.test/desktop-fixture')
    const network = data.network
      ? (
          await requestUrl({
            url: data.network,
            method: 'POST',
            headers: { 'X-Fixture': 'desktop' },
            body: 'desktop body',
          })
        ).json
      : null
    const asynchronous = await promisify((value, done) => done(null, value))(11)
    const item = this.addStatusBarItem()
    item.setText('Desktop fixture ready')
    this.addCommand({
      id: 'desktop-fixture-command',
      name: 'Desktop fixture command',
      callback: () => {
        item.setText('Desktop fixture command ran')
      },
    })
    window.__hibiDesktopFixture = {
      event,
      output,
      network,
      request: (url) => requestUrl(url),
      asynchronous,
      buffer: Buffer.isBuffer(bytes) && bytes.readUInt8(0) === 100,
      stream: stream instanceof Readable,
      stats: fs.statSync(file) instanceof fs.Stats,
      platform: os.platform(),
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
      url: new URL('https://example.test/fixture').hostname,
      dom: document === window.document && item instanceof HTMLElement,
      remote: remote.app.getName(),
      openWindow: async () => {
        const child = new remote.BrowserWindow({
          show: false,
          webPreferences: {
            sandbox: false,
            contextIsolation: false,
            nodeIntegration: true,
          },
        })
        await child.loadURL('data:text/html,<p>Desktop child fixture</p>')
        return child.id
      },
      clipboard: typeof electron.clipboard.readText === 'function',
      ipc: typeof electron.ipcRenderer.invoke === 'function',
      globalProcess: global.process === process,
      globalBuffer: global.Buffer === Buffer,
      nodeSandboxed: process.sandboxed === true,
    }
    this.register(() => {
      delete window.__hibiDesktopFixture
    })
  }
  onunload() {
    if (this.outside)
      fs.appendFileSync(path.join(this.outside, 'unloaded.txt'), 'unloaded\n')
  }
}
