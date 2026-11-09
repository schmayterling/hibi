const { Plugin, Events } = require('obsidian')

module.exports = class Pending extends Plugin {
  async onload() {
    const state = {
      started: false,
      finished: false,
      ticks: 0,
      events: 0,
      lateEvents: 0,
      unloaded: 0,
    }
    globalThis.__hibiPendingFixture = state
    state.emitter = new Events()
    this.registerEvent(state.emitter.on('pending', () => state.events++))
    this.registerDomEvent(document, 'host-pending-event', () => state.events++)
    this.registerInterval(window.setInterval(() => state.ticks++, 20))
    this.register(() => state.unloaded++)
    this.addStatusBarItem().setText('Pending fixture')
    state.seed = await this.loadData()
    state.started = true
    await new Promise((resolve) => {
      state.release = resolve
    })
    this.registerDomEvent(
      document,
      'host-pending-late',
      () => state.lateEvents++,
    )
    this.addCommand({
      id: 'late',
      name: 'Late pending command',
      callback: () => state.lateEvents++,
    })
    try {
      await this.saveData({ late: true })
    } catch {
      state.saveRefused = true
    }
    state.finished = true
  }
}
