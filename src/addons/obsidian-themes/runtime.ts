import type { AddonContext } from '../api'
import { bridgeCss, type VaultAppearance } from './bridge'

// Inline !important on the host beats any theme rule, and the closed shadow
// root keeps theme selectors out of the button itself.
const hostStyle = [
  'all: initial',
  'position: fixed',
  'inset: auto 12px 12px auto',
  'margin: 0',
  'z-index: 2147483647',
  'display: block',
  'visibility: visible',
  'opacity: 1',
  'transform: none',
  'filter: none',
  'clip-path: none',
  'pointer-events: auto',
  'contain: none',
  'content-visibility: visible',
  'zoom: 1',
  'translate: none',
  'scale: none',
  'rotate: none',
  'mask: none',
]
  .map((rule) => `${rule} !important`)
  .join('; ')
const buttonStyle =
  'all: initial; font: 13px/1.2 system-ui, sans-serif; color: #fff; background: #222; border: 1px solid #888; border-radius: 6px; padding: 6px 10px; cursor: pointer;'

export function createRuntime(context: AddonContext) {
  let style: ReturnType<AddonContext['styles']['register']> | null = null
  let safe: HTMLElement | null = null
  let safeTimer: ReturnType<typeof setTimeout> | undefined
  // Obsidian's token classes in source editors, only while a theme is on.
  let tokens: (() => void) | null = null
  // Body classes from Style Settings, removed with the theme.
  let added: string[] = []
  const root = document.documentElement
  const mode = () =>
    (root.dataset.appearance ??
      (matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light')) === 'dark'
      ? 'dark'
      : 'light'
  const classes = () => {
    if (!style) return
    const dark = mode() === 'dark'
    document.body.classList.toggle('theme-dark', dark)
    document.body.classList.toggle('theme-light', !dark)
  }
  // Follow Hibi's appearance, not the vault's Obsidian mode.
  const observer = new MutationObserver(classes)
  const media = matchMedia('(prefers-color-scheme: dark)')
  const hideSafe = () => {
    clearTimeout(safeTimer)
    safe?.remove()
    safe = null
  }
  return {
    show(
      css: string,
      appearance: VaultAppearance = {},
      bodyClasses: readonly string[] = [],
    ) {
      document.body.classList.remove(...added)
      added = bodyClasses.filter(
        (name) => !document.body.classList.contains(name),
      )
      document.body.classList.add(...added)
      tokens ??= context.editor.registerSource({
        id: 'token-classes',
        create: () =>
          import('./source-classes').then(
            (module) => module.obsidianTokenClasses,
          ),
      })
      const text = bridgeCss(appearance) + css
      if (style) style.update(text)
      else {
        style = context.styles.register('theme', text, { priority: 'override' })
        observer.observe(root, { attributeFilter: ['data-appearance'] })
        media.addEventListener('change', classes)
      }
      classes()
    },
    clear() {
      hideSafe()
      tokens?.()
      tokens = null
      if (!style) return
      style.dispose()
      style = null
      observer.disconnect()
      media.removeEventListener('change', classes)
      document.body.classList.remove('theme-dark', 'theme-light', ...added)
      added = []
    },
    /** A button themes can't hide; `timeout` removes it on its own. */
    safeButton(label: string, onClick: () => void, timeout?: number) {
      hideSafe()
      const host = document.createElement('div')
      host.setAttribute('style', hostStyle)
      host.dataset.obsidianThemesSafe = ''
      const shadow = host.attachShadow({ mode: 'closed' })
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.setAttribute('style', buttonStyle)
      button.addEventListener('click', () => {
        hideSafe()
        onClick()
      })
      shadow.append(button)
      // Outside body, so body-wide theme rules don't reach it either.
      root.append(host)
      // The top layer paints above every theme overlay and isn't clipped,
      // moved or faded by the page's own boxes.
      host.popover = 'manual'
      host.showPopover()
      safe = host
      if (timeout) safeTimer = setTimeout(hideSafe, timeout)
    },
    get active() {
      return style !== null
    },
  }
}
