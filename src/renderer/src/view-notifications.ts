import type { ViewApi, ViewNotification } from '../../addons/api'

const notifications = new Map<number, ViewNotification>()
const listeners = new Set<() => void>()
let nextId = 0
let snapshot: { id: number; notification: ViewNotification }[] = []
const publish = () => {
  snapshot = [...notifications].map(([id, notification]) => ({
    id,
    notification,
  }))
  for (const listener of listeners) listener()
}

export const viewNotifications = {
  snapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  scope() {
    const owned = new Set<() => void>()
    let stopped = false
    const notify: ViewApi['notify'] = (initial) => {
      if (stopped) return { update() {}, dispose() {} }
      const key = ++nextId
      let active = true
      notifications.set(key, initial)
      publish()
      const dispose = () => {
        if (!active) return
        active = false
        notifications.delete(key)
        owned.delete(dispose)
        publish()
      }
      owned.add(dispose)
      return {
        dispose,
        update(changes) {
          if (!active || stopped) return
          const current = notifications.get(key)
          if (!current) return
          notifications.set(key, { ...current, ...changes })
          publish()
        },
      }
    }
    return {
      notify,
      dispose() {
        stopped = true
        for (const remove of owned) remove()
      },
    }
  },
}
