// Themes describe their options in `/* @settings */` YAML comments, the format
// of the Style Settings community plugin. This reads those descriptions as
// data and turns chosen values into body classes and CSS variables; the
// plugin itself never runs.
import { parse } from 'yaml'
import { sanitizeCss, tokenize } from './sanitize.ts'

type Option = { label: string; value: string }
type Base = { id: string; title: string; description?: string }
export type StyleSetting = Base &
  (
    | { type: 'heading'; level: number }
    | { type: 'info-text' }
    | { type: 'class-toggle'; default: boolean }
    | {
        type: 'class-select'
        options: Option[]
        default: string
        allowEmpty: boolean
      }
    | { type: 'variable-text'; default: string; quotes: boolean }
    | { type: 'variable-number'; default: number; format: string }
    | {
        type: 'variable-number-slider'
        default: number
        min: number
        max: number
        step: number
        format: string
      }
    | { type: 'variable-select'; options: Option[]; default: string }
    | { type: 'variable-color'; format: ColorFormat; default: string }
    | {
        type: 'variable-themed-color'
        format: ColorFormat
        'default-light': string
        'default-dark': string
      }
  )
export type StyleSection = {
  id: string
  name: string
  settings: StyleSetting[]
}
export type StyleValues = Record<string, string | number | boolean>
type ColorFormat =
  | 'hex'
  | 'rgb'
  | 'hsl'
  | 'rgb-values'
  | 'hsl-values'
  | 'rgb-split'
  | 'hsl-split'

const MAX_SECTIONS = 50
const MAX_SETTINGS = 1000
// Class names and variable names become CSS identifiers.
const identifier = /^[a-zA-Z_][\w-]{0,99}$/
const formats = new Set([
  'hex',
  'rgb',
  'hsl',
  'rgb-values',
  'hsl-values',
  'rgb-split',
  'hsl-split',
])
const text = (value: unknown, max = 500) =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).slice(0, max)
    : ''
const number = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
const unit = (value: unknown) => {
  const format = text(value, 10)
  return /^[a-z%]*$/i.test(format) ? format : ''
}
const color = (value: unknown) => {
  const hex = text(value, 9)
  return /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(hex) ? hex : ''
}
function options(value: unknown): Option[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 200).flatMap((item): Option[] => {
    if (typeof item === 'string' || typeof item === 'number')
      return [{ label: String(item), value: String(item) }]
    if (item && typeof item === 'object') {
      const { label, value } = item as Record<string, unknown>
      const option = text(value, 200)
      return option
        ? [{ label: text(label, 200) || option, value: option }]
        : []
    }
    return []
  })
}

function setting(raw: unknown): StyleSetting | string {
  if (!raw || typeof raw !== 'object') return 'not a setting'
  const item = raw as Record<string, unknown>
  const id = text(item.id, 100)
  const type = text(item.type, 40)
  if (!identifier.test(id)) return `invalid id ${JSON.stringify(id)}`
  const base: Base = { id, title: text(item.title, 200) || id }
  const description = text(item.description)
  if (description) base.description = description
  switch (type) {
    case 'heading':
      return {
        ...base,
        type,
        level: Math.min(6, Math.max(1, number(item.level, 1))),
      }
    case 'info-text':
      return { ...base, type }
    case 'class-toggle':
      return { ...base, type, default: item.default === true }
    case 'class-select': {
      const choices = options(item.options).filter((option) =>
        identifier.test(option.value),
      )
      return {
        ...base,
        type,
        options: choices,
        default: text(item.default, 200),
        allowEmpty: item.allowEmpty === true,
      }
    }
    case 'variable-text':
      return {
        ...base,
        type,
        default: text(item.default),
        quotes: item.quotes === true,
      }
    case 'variable-number':
      return {
        ...base,
        type,
        default: number(item.default, 0),
        format: unit(item.format),
      }
    case 'variable-number-slider':
      return {
        ...base,
        type,
        default: number(item.default, 0),
        min: number(item.min, 0),
        max: number(item.max, 100),
        step: number(item.step, 1),
        format: unit(item.format),
      }
    case 'variable-select':
      return {
        ...base,
        type,
        options: options(item.options),
        default: text(item.default, 200),
      }
    case 'variable-color':
    case 'variable-themed-color': {
      const format = text(item.format, 20) || 'hex'
      if (!formats.has(format)) return `${id}: color format ${format}`
      return type === 'variable-color'
        ? {
            ...base,
            type,
            format: format as ColorFormat,
            default: color(item.default),
          }
        : {
            ...base,
            type,
            format: format as ColorFormat,
            'default-light': color(item['default-light']),
            'default-dark': color(item['default-dark']),
          }
    }
    default:
      return `${id}: setting type ${type || 'missing'}`
  }
}

/** Settings sections described in a stylesheet, plus what could not be read. */
export function readStyleSettings(css: string): {
  sections: StyleSection[]
  skipped: string[]
} {
  const sections: StyleSection[] = []
  const skipped: string[] = []
  for (const token of tokenize(css)) {
    if (token.type !== 'comment') continue
    const match = /^\/\*!?\s*@settings\b([\s\S]*?)(?:\*\/)?$/.exec(token.raw)
    if (!match) continue
    if (sections.length >= MAX_SECTIONS) {
      skipped.push('too many settings sections')
      break
    }
    let data: unknown
    try {
      // The plugin turns tabs into spaces before reading the YAML.
      data = parse((match[1] as string).replace(/\t/g, '    '), {
        maxAliasCount: 100,
      })
    } catch (error) {
      skipped.push(
        `unreadable settings: ${(error as Error).message.split('\n')[0]}`,
      )
      continue
    }
    if (!data || typeof data !== 'object') continue
    const section = data as Record<string, unknown>
    const id = text(section.id, 100)
    if (!identifier.test(id) || !Array.isArray(section.settings)) {
      skipped.push(
        `settings section ${JSON.stringify(id)} has no id or settings`,
      )
      continue
    }
    const settings: StyleSetting[] = []
    for (const raw of section.settings.slice(0, MAX_SETTINGS)) {
      const result = setting(raw)
      if (typeof result === 'string') skipped.push(result)
      else settings.push(result)
    }
    sections.push({ id, name: text(section.name, 200) || id, settings })
  }
  return { sections, skipped }
}

const rgb = (hex: string) => {
  const digits =
    hex.length === 4
      ? [...hex.slice(1)].map((c) => c + c).join('')
      : hex.slice(1, 7)
  return [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ]
}
function hsl(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map((c) => c / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (!d) return [0, 0, Math.round(l * 100)]
  const s = d / (1 - Math.abs(2 * l - 1))
  const h =
    max === r
      ? ((g - b) / d) % 6
      : max === g
        ? (b - r) / d + 2
        : (r - g) / d + 4
  return [
    Math.round((h * 60 + 360) % 360),
    Math.round(s * 100),
    Math.round(l * 100),
  ]
}
function colorDeclarations(name: string, format: ColorFormat, hex: string) {
  const [r, g, b] = rgb(hex)
  const [h, s, l] = hsl(hex)
  switch (format) {
    case 'hex':
      return [[name, hex]]
    case 'rgb':
      return [[name, `rgb(${r}, ${g}, ${b})`]]
    case 'hsl':
      return [[name, `hsl(${h}, ${s}%, ${l}%)`]]
    case 'rgb-values':
      return [[name, `${r}, ${g}, ${b}`]]
    case 'hsl-values':
      return [[name, `${h}, ${s}%, ${l}%`]]
    case 'rgb-split':
      return [
        [`${name}-r`, `${r}`],
        [`${name}-g`, `${g}`],
        [`${name}-b`, `${b}`],
      ]
    case 'hsl-split':
      return [
        [`${name}-h`, `${h}`],
        [`${name}-s`, `${s}%`],
        [`${name}-l`, `${l}%`],
      ]
  }
}

// Values are words, numbers, sizes, colours and font lists: nothing that
// calls a function, opens a string or ends a declaration. Quoted text
// settings add their own quotes.
const plain = /^[\p{L}\p{N}\s.,%#+-]{0,200}$/u

export const settingKey = (section: string, id: string) => `${section}@@${id}`

/** Body classes and the CSS for chosen values. Unchosen variables keep the theme's own defaults. */
export function styleSettingsCss(
  sections: readonly StyleSection[],
  values: StyleValues,
): { css: string; classes: string[] } {
  const classes = new Set<string>()
  const all: string[][] = []
  const light: string[][] = []
  const dark: string[][] = []
  for (const section of sections)
    for (const item of section.settings) {
      const key = settingKey(section.id, item.id)
      const value = values[key]
      const name = `--${item.id}`
      switch (item.type) {
        case 'class-toggle':
          if (typeof value === 'boolean' ? value : item.default)
            classes.add(item.id)
          break
        case 'class-select': {
          // An unlisted value falls back to the theme's default.
          const listed = (name: unknown) =>
            item.options.some((option) => option.value === name)
          const chosen = listed(value) ? (value as string) : item.default
          if (listed(chosen)) classes.add(chosen)
          break
        }
        case 'variable-text':
          if (typeof value === 'string' && plain.test(value))
            all.push([name, item.quotes ? JSON.stringify(value) : value])
          break
        case 'variable-number':
        case 'variable-number-slider':
          if (typeof value === 'number' && Number.isFinite(value))
            all.push([name, `${value}${item.format}`])
          break
        case 'variable-select':
          if (
            item.options.some((option) => option.value === value) &&
            plain.test(value as string)
          )
            all.push([name, value as string])
          break
        case 'variable-color':
          if (color(value))
            all.push(...colorDeclarations(name, item.format, value as string))
          break
        case 'variable-themed-color': {
          const pick = (mode: 'light' | 'dark') => values[`${key}@@${mode}`]
          if (color(pick('light')))
            light.push(
              ...colorDeclarations(name, item.format, pick('light') as string),
            )
          if (color(pick('dark')))
            dark.push(
              ...colorDeclarations(name, item.format, pick('dark') as string),
            )
          break
        }
      }
    }
  // A value can't open or close a rule, and the result is checked like theme CSS.
  const block = (selector: string, declarations: string[][]) =>
    declarations.length
      ? `${selector} { ${declarations
          .filter(([, value]) => !/[{};\\]|\/\*/.test(value as string))
          .map(([name, value]) => `${name}: ${value};`)
          .join(' ')} }\n`
      : ''
  const css =
    block('body.css-settings-manager', all) +
    block('body.css-settings-manager.theme-light', light) +
    block('body.css-settings-manager.theme-dark', dark)
  return {
    css: sanitizeCss(css).css,
    classes: [...classes].filter(
      (name) => name !== 'theme-dark' && name !== 'theme-light',
    ),
  }
}
