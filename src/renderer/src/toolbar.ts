import type { CommandExecutionContext } from '../../shared/foundation-contracts'
import { performanceDiagnostics } from '../../ui/diagnostics'
import type {
  ToolbarApi,
  ToolbarItem,
  ToolbarPreferences,
} from '../../ui/toolbar'

const key = 'hibi:toolbar'
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(id)
const validOrder = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter(validId))] : []
const validPlacements = (
  value: unknown,
): NonNullable<ToolbarPreferences['placements']> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          ([id, placement]) =>
            validId(id) && (placement === 'menu' || placement === 'hidden'),
        ),
      )
    : {}
let preferences: ToolbarPreferences = {
  visible: true,
  mode: 'icons',
  autoHide: true,
}
try {
  const saved = JSON.parse(localStorage.getItem(key) ?? '{}')
  if (typeof saved?.visible === 'boolean') preferences.visible = saved.visible
  if (typeof saved?.autoHide === 'boolean')
    preferences.autoHide = saved.autoHide
  if (['icons', 'icons-and-text', 'text'].includes(saved?.mode))
    preferences.mode = saved.mode
  preferences.order = validOrder(saved?.order)
  preferences.placements = validPlacements(saved?.placements)
} catch {
  /* Keep defaults when stored preferences cannot be read. */
}
type RegisteredToolbarItem = ToolbarItem & {
  onClick: (context?: CommandExecutionContext) => Promise<void>
}
const items = new Map<string, RegisteredToolbarItem>()
let snapshot = { preferences, items: [] as RegisteredToolbarItem[] }
const listeners = new Set<() => void>()
let batchDepth = 0
let pending = false
const publish = () => {
  if (batchDepth) {
    pending = true
    return
  }
  pending = false
  const rank = new Map(
    (preferences.order ?? []).map((id, index) => [id, index]),
  )
  snapshot = {
    preferences,
    items: [...items.values()].sort((a, b) => {
      const aRank = rank.get(a.id) ?? Infinity
      const bRank = rank.get(b.id) ?? Infinity
      return aRank === bRank
        ? Number(b.id.startsWith('format.')) -
            Number(a.id.startsWith('format.'))
        : aRank - bRank
    }),
  }
  for (const listener of listeners) listener()
}
function setPreferences(changes: Partial<ToolbarPreferences>) {
  preferences = {
    autoHide:
      typeof changes.autoHide === 'boolean'
        ? changes.autoHide
        : (preferences.autoHide ?? true),
    order:
      changes.order === undefined
        ? (preferences.order ?? [])
        : validOrder(changes.order),
    placements:
      changes.placements === undefined
        ? (preferences.placements ?? {})
        : validPlacements(changes.placements),
    visible:
      typeof changes.visible === 'boolean'
        ? changes.visible
        : preferences.visible,
    mode:
      changes.mode && ['icons', 'icons-and-text', 'text'].includes(changes.mode)
        ? changes.mode
        : preferences.mode,
  }
  localStorage.setItem(key, JSON.stringify(preferences))
  publish()
}

export const toolbar = {
  batch<T>(update: () => T): T {
    batchDepth++
    try {
      return update()
    } finally {
      if (--batchDepth === 0 && pending) publish()
    }
  },
  snapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  setPreferences,
  move(id: string, target: string, after = false) {
    if (id === target || !items.has(id) || !items.has(target)) return
    const order = [
      ...new Set([
        ...(preferences.order ?? []),
        ...snapshot.items.map((item) => item.id),
      ]),
    ].filter((item) => item !== id)
    order.splice(order.indexOf(target) + Number(after), 0, id)
    setPreferences({ order })
  },
  scope(
    owner: string,
    onError: (error: unknown) => void,
    runCommand?: (
      commandId: string,
      context?: CommandExecutionContext,
    ) => Promise<void>,
  ) {
    let disposed = false
    const owned = new Set<() => void>()
    const api: ToolbarApi = {
      getPreferences: () => ({
        ...preferences,
        order: [...(preferences.order ?? [])],
        placements: { ...preferences.placements },
      }),
      setPreferences(changes) {
        if (!disposed) setPreferences(changes)
      },
      register(initial) {
        if (disposed) return { update() {}, dispose() {} }
        const id = `${owner}.${initial.id}`
        if (!/^[a-z][a-z0-9-]*$/.test(initial.id) || items.has(id))
          throw new Error(`duplicate or invalid toolbar item: ${id}`)
        let active = true
        let item = initial
        const validate = (next: ToolbarItem) => {
          if (
            (next.commandId !== undefined &&
              (!/^[a-z][a-z0-9-]*$/.test(next.commandId) || !runCommand)) ||
            (next.commandId === undefined) ===
              (typeof next.onClick !== 'function')
          )
            throw new Error(`invalid toolbar action: ${id}`)
        }
        validate(item)
        const render = () => {
          items.set(id, {
            ...item,
            id,
            async onClick(context?: CommandExecutionContext) {
              if (!active || disposed || item.disabled) return
              try {
                await performanceDiagnostics.measure(
                  owner,
                  `toolbar:${item.id}`,
                  () =>
                    item.commandId
                      ? runCommand?.(item.commandId, context)
                      : item.onClick?.(),
                )
              } catch (error) {
                onError(error)
              }
            },
          })
          publish()
        }
        const dispose = () => {
          if (!active) return
          active = false
          items.delete(id)
          owned.delete(dispose)
          publish()
        }
        owned.add(dispose)
        render()
        return {
          dispose,
          update(changes) {
            if (!active || disposed) return
            if (
              Object.entries(changes).every(
                ([key, value]) => item[key as keyof ToolbarItem] === value,
              )
            )
              return
            const next = { ...item, ...changes }
            validate(next)
            item = next
            render()
          },
        }
      },
    }
    return {
      api,
      dispose() {
        disposed = true
        for (const remove of owned) remove()
      },
    }
  },
}
