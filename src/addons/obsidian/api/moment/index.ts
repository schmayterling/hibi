/// <reference path="./locales.d.ts" />
import moment from 'moment/moment.js'
import type { Component } from '../core/component'

export { moment }

let ready: Promise<unknown> | undefined

/** Locales arrive with the first trusted plugin, keeping synchronous moment.locale intact. */
export async function loadMomentLocale(locale?: string | string[]) {
  ready ??= import('moment/min/locales.js')
  await ready
  if (Array.isArray(locale)) moment.locale(locale)
  else if (locale) moment.locale(locale)
}

let prepared: Promise<void> | undefined
export function prepareMoment() {
  prepared ??= loadMomentLocale(
    typeof navigator === 'undefined' ? 'en' : [...navigator.languages],
  )
  return prepared
}

let users = 0
let previous: PropertyDescriptor | undefined
export function acquireMoment(owner: Component) {
  if (users++ === 0) {
    previous = Object.getOwnPropertyDescriptor(globalThis, 'moment')
    Object.defineProperty(globalThis, 'moment', {
      configurable: true,
      writable: true,
      value: moment,
    })
  }
  owner.register(() => {
    if (--users !== 0) return
    if (previous) Object.defineProperty(globalThis, 'moment', previous)
    else Reflect.deleteProperty(globalThis, 'moment')
  })
  return moment
}
