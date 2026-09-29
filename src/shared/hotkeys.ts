export const HOTKEY_CHANNELS = {
  get: 'hotkeys:get',
  save: 'hotkeys:save',
  record: 'hotkeys:record',
  command: 'app:command',
} as const

export const actions = [
  { id: 'palette', label: 'Command palette', category: 'app', key: 'k' },
  { id: 'new', label: 'New document', category: 'file', key: 'n' },
  { id: 'close-tab', label: 'Close tab', category: 'file', key: 'w' },
  { id: 'open', label: 'Open document…', category: 'file', key: 'o' },
  {
    id: 'open-workspace',
    label: 'Open workspace…',
    category: 'file',
    key: 'shift+o',
  },
  { id: 'save', label: 'Save document', category: 'file', key: 's' },
  { id: 'import', label: 'Import into workspace…', category: 'file', key: '' },
  { id: 'saveAs', label: 'Save as…', category: 'file', key: 'shift+s' },
  { id: 'history', label: 'Version history', category: 'file', key: '' },
  { id: 'find', label: 'Find in document', category: 'edit', key: 'f' },
  { id: 'settings', label: 'Open settings', category: 'preferences', key: ',' },
  {
    id: 'previous-tab',
    label: 'Previous tab',
    category: 'view',
    key: 'alt+arrowleft',
  },
  {
    id: 'next-tab',
    label: 'Next tab',
    category: 'view',
    key: 'alt+arrowright',
  },
  { id: 'back', label: 'Go back', category: 'view', key: '[' },
  { id: 'forward', label: 'Go forward', category: 'view', key: ']' },
  {
    id: 'install-addon',
    label: 'Install addon…',
    category: 'preferences',
    key: '',
  },
  { id: 'toggle-sidebar', label: 'Toggle sidebar', category: 'view', key: '/' },
  {
    id: 'toggle-right-sidebar',
    label: 'Toggle right sidebar',
    category: 'view',
    key: '',
  },
  { id: 'toggle-zen', label: 'Toggle zen mode', category: 'view', key: '' },
  { id: 'normal', label: 'Normal view', category: 'view', key: 'shift+[' },
  {
    id: 'side-by-side',
    label: 'Side-by-side view',
    category: 'view',
    key: 'shift+\\',
  },
  { id: 'markdown', label: 'Source view', category: 'view', key: 'shift+]' },
  {
    id: 'toggle-titlebar',
    label: 'Toggle top bar auto-hide',
    category: 'appearance',
    key: '',
  },
] as const

export type AppCommand = (typeof actions)[number]['id']
export type Hotkeys = Record<AppCommand, string>
export const HOTKEYS_VERSION = 2

export function restoreHotkeys(
  stored: Record<string, unknown>,
  platform: string,
): Hotkeys {
  const next = defaultHotkeys(platform)
  for (const { id } of actions) {
    if (typeof stored[id] === 'string') next[id] = stored[id]
    else if (Object.values(stored).includes(next[id])) next[id] = ''
  }
  if (stored._version !== HOTKEYS_VERSION) {
    const defaults = defaultHotkeys(platform)
    const mod = platform === 'darwin' ? 'meta' : 'ctrl'
    for (const [id, key] of [
      ['normal', '['],
      ['markdown', ']'],
    ] as const) {
      if (
        next[id] === `${mod}+${key}` &&
        !Object.entries(next).some(
          ([other, value]) => other !== id && value === defaults[id],
        )
      )
        next[id] = defaults[id]
    }
  }
  // New navigation defaults yield to an existing user binding.
  const defaults = defaultHotkeys(platform)
  for (const id of ['back', 'forward', 'previous-tab', 'next-tab'] as const) {
    const occupied = Object.entries(next).some(
      ([other, value]) => other !== id && value === defaults[id],
    )
    if (next[id] === defaults[id] && occupied) next[id] = ''
    else if (typeof stored[id] !== 'string' && !occupied)
      next[id] = defaults[id]
  }
  return validateHotkeys(next, platform)
}

export function defaultHotkeys(platform: string): Hotkeys {
  const modifier = platform === 'darwin' ? 'meta' : 'ctrl'
  return Object.fromEntries(
    actions.map(({ id, key }) => [id, key ? `${modifier}+${key}` : '']),
  ) as Hotkeys
}

const modifiers = ['ctrl', 'meta', 'alt', 'shift']
const punctuation: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Space: 'space',
}
const specialKeys = [
  'space',
  'enter',
  'tab',
  'backspace',
  'delete',
  'home',
  'end',
  'pageup',
  'pagedown',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
]

export function shortcutFromEvent(event: {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}): string {
  const key = /^Key[A-Z]$/.test(event.code)
    ? event.code.slice(3).toLowerCase()
    : /^Digit[0-9]$/.test(event.code)
      ? event.code.slice(5)
      : (punctuation[event.code] ?? event.key.toLowerCase())
  if (!isKey(key)) return ''
  return [
    event.ctrlKey && 'ctrl',
    event.metaKey && 'meta',
    event.altKey && 'alt',
    event.shiftKey && 'shift',
    key,
  ]
    .filter(Boolean)
    .join('+')
}

function isKey(key: string): boolean {
  return (
    /^[a-z0-9,./;'[\]\\`=-]$/.test(key) ||
    /^f([1-9]|1[0-9]|2[0-4])$/.test(key) ||
    specialKeys.includes(key)
  )
}

export function shortcutError(
  shortcut: string,
  platform: string,
  action?: AppCommand,
): string | null {
  if (!shortcut) return null
  const parts = shortcut.split('+')
  const key = parts.pop() ?? ''
  if (
    !isKey(key) ||
    parts.join('+') !==
      modifiers.filter((modifier) => parts.includes(modifier)).join('+')
  )
    return 'Choose a supported key combination.'
  if (!parts.some((part) => part !== 'shift') && !/^f\d+$/.test(key))
    return `Include ${platform === 'darwin' ? 'Command, Control, or Option' : 'Ctrl or Alt'}, or use a function key.`
  const mod = platform === 'darwin' ? 'meta' : 'ctrl'
  if (shortcut === `${mod}+w` && action !== 'close-tab')
    return 'This shortcut closes tabs. Choose another combination.'
  const reserved = [
    'a',
    'c',
    'v',
    'x',
    'z',
    'shift+z',
    'shift+v',
    'y',
    'q',
    'h',
    'm',
    'r',
    'shift+r',
    'shift+i',
    '0',
    '-',
    '=',
    'shift+=',
  ].map((key) => `${mod}+${key}`)
  if (
    reserved.includes(shortcut) ||
    ['alt+f4', 'ctrl+alt+delete', 'ctrl+meta+f', 'meta+alt+h'].includes(
      shortcut,
    )
  )
    return 'This shortcut is reserved for editing or window controls. Choose another combination.'
  return null
}

export function validateHotkeys(value: unknown, platform: string): Hotkeys {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== actions.length
  )
    throw new Error('Could not read these shortcut settings.')
  const result = {} as Hotkeys
  const used = new Set<string>()
  for (const { id } of actions) {
    const shortcut = (value as Record<string, unknown>)[id]
    if (typeof shortcut !== 'string' || shortcut.length > 60)
      throw new Error('Choose a supported key combination.')
    const error = shortcutError(shortcut, platform, id)
    if (error) throw new Error(error)
    if (shortcut && used.has(shortcut))
      throw new Error(
        'This shortcut is assigned to another action. Choose another combination.',
      )
    if (shortcut) used.add(shortcut)
    result[id] = shortcut
  }
  return result
}

export function accelerator(shortcut: string): string {
  const keys: Record<string, string> = {
    meta: 'Super',
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    arrowup: 'Up',
    arrowdown: 'Down',
    arrowleft: 'Left',
    arrowright: 'Right',
  }
  return shortcut
    ? shortcut
        .split('+')
        .map((key) => keys[key] ?? key)
        .join('+')
    : ''
}

export function shortcutLabels(shortcut: string, platform: string): string[] {
  const parts = shortcut.split('+')
  if (parts.includes('shift') && parts.at(-1) === '\\') {
    parts.splice(parts.indexOf('shift'), 1)
    parts[parts.length - 1] = '|'
  }
  const keys: Record<string, string> =
    platform === 'darwin'
      ? { meta: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' }
      : { meta: 'win', ctrl: 'ctrl', alt: 'alt', shift: 'shift' }
  return parts.filter(Boolean).map(
    (key) =>
      keys[key] ??
      {
        arrowup: '↑',
        arrowdown: '↓',
        arrowleft: '←',
        arrowright: '→',
        enter: '↵',
        escape: 'esc',
      }[key] ??
      key,
  )
}
