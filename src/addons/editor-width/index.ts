import { defineAddon } from '../api'
import manifest from './manifest'
import {
  getPreferences,
  onPreferencesChange,
  setPreferences,
} from './preferences'

let stop: (() => void) | undefined

export default defineAddon({
  manifest,
  start(context) {
    context.commands.register({
      id: 'toggle',
      label: 'Toggle editor width',
      run: () => {
        setPreferences({ capped: !getPreferences().capped })
      },
    })
    const slider = () => {
      const preferences = getPreferences()
      return {
        min: preferences.minimum,
        max: preferences.maximum,
        step: 'any' as const,
        value: preferences.width,
        valueText: `${preferences.width}${preferences.unit}`,
        disabled: !preferences.capped,
        onChange: (width: number) => {
          setPreferences({ width })
        },
      }
    }
    const toggle = () => ({
      checked: getPreferences().capped,
      onChange: (capped: boolean) => {
        setPreferences({ capped })
      },
    })
    const style = context.styles.register('width', '')
    const width = context.statusBar.register({
      id: 'width',
      label: getPreferences().showSlider ? 'Editor width' : '',
      tooltip: 'Adjust the width of the editing panes.',
      slider: slider(),
    })
    const cap = context.statusBar.register({
      id: 'cap',
      label: getPreferences().showToggle ? 'Width cap' : '',
      tooltip: 'Limit the editor to your chosen width.',
      toggle: toggle(),
    })
    const refresh = () => {
      const preferences = getPreferences()
      style.update(
        preferences.capped
          ? `.editor-panes :is(.source-editor, .rich-editor-host) {
              width: min(100%, ${preferences.width}${preferences.unit});
              margin-inline: auto;
            }`
          : '',
      )
      width.update({
        label: preferences.showSlider ? 'Editor width' : '',
        slider: slider(),
      })
      cap.update({
        label: preferences.showToggle ? 'Width cap' : '',
        toggle: toggle(),
      })
    }
    stop = onPreferencesChange(refresh)
    refresh()
  },
  stop() {
    stop?.()
    stop = undefined
  },
})
