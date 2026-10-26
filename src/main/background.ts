import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, Menu, Tray } from 'electron'
import { writeText } from './files'
import { getUiCase } from './ui-case'

export class BackgroundMode {
  private value = false
  private tray: Tray | null = null
  private writing: Promise<unknown> = Promise.resolve()
  private readonly path = join(app.getPath('userData'), 'background.json')

  constructor(
    private readonly actions: {
      open: () => void
      settings: () => void
      quickNote: () => void
      hasQuickNote: () => boolean
    },
  ) {}

  get enabled() {
    return this.value && this.tray !== null && !this.tray.isDestroyed()
  }

  async load() {
    try {
      this.value = JSON.parse(await readFile(this.path, 'utf8')) === true
    } catch {
      this.value = false
    }
    try {
      this.refresh()
    } catch (error) {
      this.value = false
      this.dispose()
      console.error('Could not create the background tray:', error)
    }
  }

  save(input: unknown): Promise<boolean> {
    if (typeof input !== 'boolean')
      throw new Error('Choose whether to keep Hibi running in the background.')
    const writing = this.writing
      .catch(() => {})
      .then(async () => {
        const candidate = input && !this.tray ? this.createTray() : null
        try {
          await writeText(this.path, JSON.stringify(input))
        } catch (error) {
          candidate?.destroy()
          throw error
        }
        this.value = input
        if (candidate) this.tray = candidate
        this.refresh()
        return this.enabled
      })
    this.writing = writing
    return writing
  }

  private createTray() {
    const name =
      process.platform === 'darwin'
        ? 'trayTemplate.png'
        : process.platform === 'win32'
          ? 'tray.ico'
          : 'tray.png'
    const tray = new Tray(
      app.isPackaged
        ? join(process.resourcesPath, 'icons', name)
        : join(app.getAppPath(), 'build', name),
    )
    try {
      tray.setToolTip('Hibi')
      // Windows: left click. Linux: StatusNotifierItem "Activate" (usually left
      // click, desktop-dependent). macOS keeps click-to-open-menu.
      if (process.platform !== 'darwin') tray.on('click', this.actions.open)
      tray.setContextMenu(this.menu())
      return tray
    } catch (error) {
      tray.destroy()
      throw error
    }
  }

  private menu() {
    const menu = Menu.buildFromTemplate([
      { label: 'Open Hibi', click: this.actions.open },
      ...(this.actions.hasQuickNote()
        ? [{ label: 'New quick note', click: this.actions.quickNote }]
        : []),
      { label: 'Settings', click: this.actions.settings },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
    if (getUiCase() === 'lowercase')
      for (const item of menu.items) item.label = item.label.toLocaleLowerCase()
    return menu
  }

  refresh() {
    if (!this.value) this.dispose()
    else if (!this.tray) this.tray = this.createTray()
    // Linux needs the context menu assigned again after command availability changes.
    else this.tray.setContextMenu(this.menu())
  }

  dispose() {
    this.tray?.destroy()
    this.tray = null
  }
}
