import type { StatusItem } from '../../addons/api'
import { sentenceCase } from '../../shared/ui-case'
import { Slider, Toggle } from '../../ui/Controls'

export type StatusBarVisibility = 'shown' | 'auto' | 'hidden'

export function StatusBar({
  items,
  visibility = 'shown',
}: {
  items: readonly StatusItem[]
  visibility?: StatusBarVisibility
}) {
  if (!items.length || visibility === 'hidden') return null
  return (
    <div className="statusbar-slot" data-visibility={visibility}>
      <section className="app-statusbar" aria-label="Editor status">
        {items.map((item) =>
          item.slider ? (
            <label
              key={item.id}
              htmlFor={`status-slider-${item.id}`}
              className="status-pill status-slider"
              data-status-id={item.id}
              data-tooltip={item.tooltip}
            >
              <span>
                {item.verbatim ? item.label : sentenceCase(item.label)}
              </span>
              <Slider
                id={`status-slider-${item.id}`}
                min={item.slider.min}
                max={item.slider.max}
                step={item.slider.step}
                value={item.slider.value}
                disabled={item.slider.disabled}
                aria-valuetext={item.slider.valueText}
                onChange={(event) =>
                  void item.slider?.onChange(event.currentTarget.valueAsNumber)
                }
              />
            </label>
          ) : item.toggle ? (
            <label
              key={item.id}
              htmlFor={`status-toggle-${item.id}`}
              className="status-pill status-toggle"
              data-status-id={item.id}
              data-tooltip={item.tooltip}
            >
              <Toggle
                id={`status-toggle-${item.id}`}
                checked={item.toggle.checked}
                onChange={(event) =>
                  void item.toggle?.onChange(event.currentTarget.checked)
                }
              />
              <span>
                {item.verbatim ? item.label : sentenceCase(item.label)}
              </span>
            </label>
          ) : item.onClick ? (
            <button
              key={item.id}
              type="button"
              className="status-pill"
              data-status-id={item.id}
              data-verbatim={item.verbatim}
              data-tooltip={item.tooltip}
              onClick={() => void item.onClick?.()}
            >
              {item.verbatim ? item.label : sentenceCase(item.label)}
            </button>
          ) : (
            <span
              key={item.id}
              className="status-pill"
              data-status-id={item.id}
              data-verbatim={item.verbatim}
              data-tooltip={item.tooltip}
              role="status"
            >
              {item.verbatim ? item.label : sentenceCase(item.label)}
            </span>
          ),
        )}
      </section>
    </div>
  )
}
