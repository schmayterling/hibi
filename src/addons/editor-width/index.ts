import { defineAddon } from '../api'
import manifest from './manifest'

const preference = 'editor-width.pixels'
const minimum = 320
const maximum = 1600
const step = 10
const defaultWidth = 800

function readWidth() {
  const saved = Number(localStorage.getItem(preference) ?? defaultWidth)
  return Number.isFinite(saved)
    ? Math.max(minimum, Math.min(maximum, Math.round(saved / step) * step))
    : defaultWidth
}

function styles(width: number) {
  return `.editor-panes :is(.source-editor, .rich-editor-host) {
    width: min(100%, ${width}px);
    margin-inline: auto;
  }`
}

export default defineAddon({
  manifest,
  start(context) {
    const width = readWidth()
    const style = context.styles.register('width', styles(width))
    const slider = (value: number) => ({
      min: minimum,
      max: maximum,
      step,
      value,
      valueText: `${value} pixels`,
      onChange(value: number) {
        const width = Math.max(
          minimum,
          Math.min(maximum, Math.round(value / step) * step),
        )
        style.update(styles(width))
        status.update({ slider: slider(width) })
        localStorage.setItem(preference, String(width))
      },
    })
    const status = context.statusBar.register({
      id: 'width',
      label: 'Editor width',
      tooltip: 'Adjust the width of the editing panes.',
      slider: slider(width),
    })
  },
})
