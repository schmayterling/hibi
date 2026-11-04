export type WidthPreferences = {
  minimum: number
  maximum: number
  unit: string
  width: number
  capped: boolean
}

const key = 'editor-width.preferences'
const previousKey = 'editor-width.pixels'
const settingsEvent = 'hibi:editor-width-settings'
const defaults: WidthPreferences = {
  minimum: 320,
  maximum: 1600,
  unit: 'px',
  width: 800,
  capped: true,
}

export function validUnit(unit: string) {
  return /^(?:[a-z]+|%)$/i.test(unit) && CSS.supports('width', `1${unit}`)
}

function normalize(value: Partial<WidthPreferences>): WidthPreferences {
  const minimum = value.minimum ?? defaults.minimum
  const maximum = value.maximum ?? defaults.maximum
  const validRange =
    Number.isFinite(minimum) &&
    Number.isFinite(maximum) &&
    minimum >= 0 &&
    maximum > minimum
  const min = validRange ? minimum : defaults.minimum
  const max = validRange ? maximum : defaults.maximum
  const unit =
    typeof value.unit === 'string' ? value.unit.trim().toLowerCase() : ''
  const width = Number.isFinite(value.width)
    ? Number(value.width)
    : defaults.width
  return {
    minimum: min,
    maximum: max,
    unit: validUnit(unit) ? unit : defaults.unit,
    width: Math.max(min, Math.min(max, Number(width.toPrecision(12)))),
    capped: value.capped !== false,
  }
}

export function getPreferences(): WidthPreferences {
  let saved: Partial<WidthPreferences> = {}
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (value && typeof value === 'object' && !Array.isArray(value))
      saved = value as Partial<WidthPreferences>
  } catch {
    // Keep the previous pixel width if the preferences cannot be read.
  }
  return normalize({
    ...saved,
    width:
      saved.width ??
      Number(localStorage.getItem(previousKey) ?? defaults.width),
  })
}

export function setPreferences(changes: Partial<WidthPreferences>) {
  const next = normalize({ ...getPreferences(), ...changes })
  localStorage.setItem(key, JSON.stringify(next))
  window.dispatchEvent(new Event(settingsEvent))
  return next
}

export function onPreferencesChange(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (
      event.storageArea === localStorage &&
      (event.key === key || event.key === previousKey || event.key === null)
    )
      listener()
  }
  window.addEventListener(settingsEvent, listener)
  window.addEventListener('storage', storage)
  return () => {
    window.removeEventListener(settingsEvent, listener)
    window.removeEventListener('storage', storage)
  }
}
