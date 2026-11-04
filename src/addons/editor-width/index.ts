import { defineAddon } from '../api'
import manifest from './manifest'

const preference = 'editor-width.percentage'
const minimum = 30
const maximum = 100

function readWidth() {
  const saved = Number(localStorage.getItem(preference) ?? maximum)
  return Number.isFinite(saved)
    ? Math.max(minimum, Math.min(maximum, Math.round(saved)))
    : maximum
}

function styles(width: number) {
  return `.editor-panes :is(.source-editor, .rich-editor-host) {
    width: min(100%, max(240px, ${width}%));
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
      step: 1,
      value,
      valueText: `${value}%`,
      onChange(value: number) {
        const width = Math.max(minimum, Math.min(maximum, Math.round(value)))
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
