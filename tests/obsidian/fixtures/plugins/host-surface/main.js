const {
  Plugin,
  PluginSettingTab,
  Setting,
  Component,
  Events,
  Notice,
  Modal,
  Menu,
  Scope,
  Keymap,
  Platform,
  normalizePath,
  debounce,
  addIcon,
  getIcon,
  setIcon,
  parseYaml,
  stringifyYaml,
  requestUrl,
} = require('obsidian')

class Tab extends PluginSettingTab {
  display() {
    this.containerEl.empty()
    new Setting(this.containerEl)
      .setName('Fixture toggle')
      .setDesc('Persist this value in the Hibi overlay.')
      .addToggle((control) =>
        control
          .setValue(this.plugin.settings.enabled)
          .onChange(async (value) => {
            this.plugin.settings.enabled = value
            await this.plugin.saveData(this.plugin.settings)
          }),
      )
    new Setting(this.containerEl).setName('Fixture text').addText((control) =>
      control
        .setPlaceholder('Type text')
        .setValue('hello')
        .onChange((value) => {
          this.plugin.fixture.text = value
        }),
    )
    new Setting(this.containerEl)
      .setName('Fixture area')
      .addTextArea((control) =>
        control.setValue('line one').onChange((value) => {
          this.plugin.fixture.area = value
        }),
      )
    new Setting(this.containerEl)
      .setName('Fixture choice')
      .addDropdown((control) =>
        control
          .addOptions({ first: 'First', second: 'Second' })
          .setValue('first')
          .onChange((value) => {
            this.plugin.fixture.choice = value
          }),
      )
    new Setting(this.containerEl)
      .setName('Fixture slider')
      .addSlider((control) =>
        control
          .setLimits(0, 10, 1)
          .setValue(3)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.fixture.slider = value
          }),
      )
    new Setting(this.containerEl)
      .setName('Fixture color')
      .addColorPicker((control) =>
        control.setValue('#112233').onChange((value) => {
          this.plugin.fixture.color = value
        }),
      )
    new Setting(this.containerEl)
      .setName('Fixture search')
      .addSearch((control) =>
        control.setValue('find').onChange((value) => {
          this.plugin.fixture.search = value
        }),
      )
    new Setting(this.containerEl)
      .setName('Fixture date')
      .addMomentFormat((control) =>
        control.setDefaultFormat('YYYY-MM-DD').setValue('YYYY'),
      )
    new Setting(this.containerEl)
      .setName('Fixture action')
      .addButton((control) =>
        control.setButtonText('Fixture button').onClick(() => {
          this.plugin.fixture.buttons++
        }),
      )
    new Setting(this.containerEl)
      .setName('Fixture extra')
      .addExtraButton((control) =>
        control
          .setIcon('check')
          .setTooltip('Fixture extra button')
          .onClick(() => {
            this.plugin.fixture.buttons++
          }),
      )
  }
}

module.exports = class HostSurface extends Plugin {
  async onload() {
    this.fixture = globalThis.__hibiHostFixture = {
      ticks: 0,
      clicks: 0,
      events: 0,
      unloaded: 0,
      childUnloaded: 0,
      commands: 0,
      checked: 0,
      buttons: 0,
      ribbon: 0,
      modalOpened: 0,
      modalClosed: 0,
      menu: 0,
      keys: 0,
      delayed: 0,
    }
    const fixture = this.fixture
    this.settings = (await this.loadData()) || { enabled: false }
    this.events = fixture.emitter = new Events()
    this.registerEvent(this.events.on('fixture', () => fixture.events++))
    this.registerDomEvent(
      document,
      'host-fixture-event',
      () => fixture.clicks++,
    )
    this.registerInterval(window.setInterval(() => fixture.ticks++, 40))
    const child = this.addChild(new Component())
    child.register(() => fixture.childUnloaded++)
    this.register(() => fixture.unloaded++)
    fixture.platform = {
      desktop: Platform.isDesktopApp,
      mobile: Platform.isMobile,
      mac: Platform.isMacOS,
    }
    fixture.path = normalizePath('/folder\\note//')
    fixture.yaml = parseYaml(stringifyYaml({ fixture: true }))
    fixture.hasMoment = 'moment' in require('obsidian')
    addIcon('host-fixture', '<path d="M10 10h80v80H10z"/>')
    fixture.icon = !!getIcon('host-fixture') && !!getIcon('settings')
    fixture.rawElement = document.createElement('div')
    fixture.rawElement.createSpan({ text: 'scoped helper' })
    fixture.rawElement.addClass('one', 'two')
    fixture.rawElement.removeClass('two')
    fixture.rawElement.toggleClass('three', true)
    fixture.rawElement.setAttr('data-fixture', 'yes')
    setIcon(fixture.rawElement, 'host-fixture')
    const status = this.addStatusBarItem()
    status.setText('Fixture status')
    const ribbon = this.addRibbonIcon(
      'check',
      'Fixture ribbon',
      () => fixture.ribbon++,
    )
    ribbon.addClass('host-fixture-style')
    this.addSettingTab(new Tab(this.app, this))
    const scope = new Scope(this.app.scope)
    const key = scope.register([], 'F6', () => {
      fixture.keys++
      return false
    })
    this.app.keymap.pushScope(scope)
    this.register(() => {
      scope.unregister(key)
      this.app.keymap.popScope(scope)
    })
    fixture.isMod = Keymap.isModifier(
      new KeyboardEvent('keydown', { ctrlKey: true }),
      'Ctrl',
    )
    this.addCommand({
      id: 'count',
      name: 'Count fixture runs',
      callback: async () => {
        fixture.commands++
        this.settings.commands = fixture.commands
        await this.saveData(this.settings)
      },
    })
    this.addCommand({
      id: 'checked',
      name: 'Checked fixture action',
      checkCallback: (checking) => {
        if (!checking) fixture.checked++
        return true
      },
    })
    const delayed = debounce(() => fixture.delayed++, 3600000, true)
    fixture.debounced = delayed
    this.addCommand({
      id: 'schedule',
      name: 'Schedule fixture callback',
      callback: () => {
        delayed()
      },
    })
    class FixtureModal extends Modal {
      onOpen() {
        fixture.modalOpened++
        this.contentEl.createEl('p', { text: 'Fixture modal content' })
      }
      onClose() {
        fixture.modalClosed++
      }
    }
    fixture.openModal = () =>
      new FixtureModal(this.app).setTitle('Fixture modal').open()
    fixture.openMenu = () =>
      new Menu()
        .addItem((item) =>
          item
            .setTitle('Fixture menu item')
            .setIcon('check')
            .onClick(() => fixture.menu++),
        )
        .showAtPosition({ x: 200, y: 200 })
    fixture.notice = new Notice('Fixture notice', 0)
    try {
      this.registerObsidianProtocolHandler('fixture', () => {})
    } catch {
      fixture.protocolRefused = true
    }
    try {
      await requestUrl({ url: 'https://example.test', method: 'DELETE' })
    } catch {
      fixture.networkRefused = true
    }
    fixture.loaded = true
  }
}
