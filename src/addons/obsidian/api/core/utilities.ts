import { parse, stringify } from 'yaml'

export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\u00a0/g, ' ')
    .normalize('NFC')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/|\/$/g, '')
}

export function debounce<T extends unknown[], V>(
  callback: (...args: T) => V,
  timeout = 0,
  resetTimer = false,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: { args: T; receiver: unknown } | undefined
  function debounced(this: unknown, ...args: T) {
    pending = { args, receiver: this }
    if (timer !== undefined && !resetTimer) return debounced
    clearTimeout(timer)
    timer = setTimeout(() => debounced.run(), timeout)
    return debounced
  }
  debounced.cancel = () => {
    clearTimeout(timer)
    timer = undefined
    pending = undefined
    return debounced
  }
  debounced.run = (): V | undefined => {
    const call = pending
    debounced.cancel()
    return call ? callback.apply(call.receiver, call.args) : undefined
  }
  return debounced
}

export const parseYaml = (source: string): unknown =>
  parse(source, { maxAliasCount: 100 })
export const stringifyYaml = (value: unknown): string => stringify(value)
