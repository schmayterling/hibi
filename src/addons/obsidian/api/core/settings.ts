import { childElement, ownerOf } from './dom'
import { reportError } from './events'
import { setIcon } from './icons'

function observeResult(value: unknown): void {
  if (value instanceof Promise) void value.catch(reportError)
}

function listen<K extends keyof HTMLElementEventMap>(
  element: HTMLElement,
  type: K,
  callback: (event: HTMLElementEventMap[K]) => unknown,
) {
  const listener = (event: Event) => {
    try {
      observeResult(callback(event as HTMLElementEventMap[K]))
    } catch (error) {
      reportError(error)
    }
  }
  element.addEventListener(type, listener)
  ownerOf(element)?.register(() => element.removeEventListener(type, listener))
}

export class BaseComponent {
  disabled = false
  constructor(readonly element: HTMLElement) {}
  // biome-ignore lint/suspicious/noThenProperty: Obsidian's synchronous fluent API is named then.
  then(callback: (component: this) => unknown): this {
    callback(this)
    return this
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled
    if ('disabled' in this.element)
      (this.element as HTMLInputElement).disabled = disabled
    this.element.setAttribute('aria-disabled', String(disabled))
    return this
  }
}

export class ButtonComponent extends BaseComponent {
  buttonEl: HTMLButtonElement
  private clicked: (event: MouseEvent) => unknown = () => {}
  constructor(container: HTMLElement) {
    const element = childElement(container, 'button')
    element.type = 'button'
    super(element)
    this.buttonEl = element
    listen(element, 'click', (event) => this.clicked(event))
  }
  setButtonText(text: string): this {
    this.buttonEl.textContent = text
    return this
  }
  setTooltip(text: string): this {
    this.buttonEl.title = text
    this.buttonEl.setAttribute('aria-label', text)
    return this
  }
  setIcon(icon: string): this {
    setIcon(this.buttonEl, icon)
    return this
  }
  setClass(cls: string): this {
    this.buttonEl.classList.add(...cls.split(/\s+/).filter(Boolean))
    return this
  }
  setCta(): this {
    return this.setClass('mod-cta')
  }
  removeCta(): this {
    this.buttonEl.classList.remove('mod-cta')
    return this
  }
  setWarning(): this {
    return this.setDestructive()
  }
  setDestructive(): this {
    return this.setClass('mod-warning')
  }
  removeDestructive(): this {
    this.buttonEl.classList.remove('mod-warning')
    return this
  }
  onClick(callback: (event: MouseEvent) => unknown): this {
    this.clicked = callback
    return this
  }
}
export class ExtraButtonComponent extends ButtonComponent {
  extraSettingsEl = this.buttonEl
}

export class AbstractTextComponent<
  T extends HTMLInputElement | HTMLTextAreaElement,
> extends BaseComponent {
  private changed: (value: string) => unknown = () => {}
  constructor(readonly inputEl: T) {
    super(inputEl)
    listen(inputEl, 'input', () => this.onChanged())
  }
  getValue() {
    return this.inputEl.value
  }
  setValue(value: string): this {
    this.inputEl.value = value
    return this
  }
  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder
    return this
  }
  onChange(callback: (value: string) => unknown): this {
    this.changed = callback
    return this
  }
  onChanged(): void {
    observeResult(this.changed(this.getValue()))
  }
}
export class TextComponent extends AbstractTextComponent<HTMLInputElement> {
  constructor(container: HTMLElement) {
    const element = childElement(container, 'input')
    element.type = 'text'
    super(element)
  }
}
export class TextAreaComponent extends AbstractTextComponent<HTMLTextAreaElement> {
  constructor(container: HTMLElement) {
    super(childElement(container, 'textarea'))
  }
}

export class ToggleComponent extends BaseComponent {
  toggleEl: HTMLInputElement
  private changed: (value: boolean) => unknown = () => {}
  constructor(container: HTMLElement) {
    const element = childElement(container, 'input')
    element.type = 'checkbox'
    super(element)
    this.toggleEl = element
    listen(element, 'change', () => this.changed(this.getValue()))
  }
  getValue() {
    return this.toggleEl.checked
  }
  setValue(value: boolean): this {
    this.toggleEl.checked = value
    return this
  }
  setTooltip(text: string): this {
    this.toggleEl.title = text
    return this
  }
  onClick(): void {
    if (this.disabled) return
    this.setValue(!this.getValue())
    observeResult(this.changed(this.getValue()))
  }
  onChange(callback: (value: boolean) => unknown): this {
    this.changed = callback
    return this
  }
}

export class DropdownComponent extends BaseComponent {
  selectEl: HTMLSelectElement
  private changed: (value: string) => unknown = () => {}
  constructor(container: HTMLElement) {
    const element = childElement(container, 'select')
    super(element)
    this.selectEl = element
    listen(element, 'change', () => this.changed(this.getValue()))
  }
  addOption(value: string, display: string): this {
    const option = this.selectEl.ownerDocument.createElement('option')
    option.value = value
    option.textContent = display
    this.selectEl.append(option)
    return this
  }
  addOptions(options: Record<string, string>): this {
    for (const [value, display] of Object.entries(options))
      this.addOption(value, display)
    return this
  }
  getValue() {
    return this.selectEl.value
  }
  setValue(value: string): this {
    this.selectEl.value = value
    return this
  }
  onChange(callback: (value: string) => unknown): this {
    this.changed = callback
    return this
  }
}

export class SliderComponent extends BaseComponent {
  sliderEl: HTMLInputElement
  private changed: (value: number) => unknown = () => {}
  constructor(container: HTMLElement) {
    const element = childElement(container, 'input')
    element.type = 'range'
    super(element)
    this.sliderEl = element
    listen(element, 'input', () => {
      if (this.dynamicTooltip) element.title = element.value
      if (this.instant) return this.changed(this.getValue())
    })
    listen(element, 'change', () => {
      if (!this.instant) return this.changed(this.getValue())
    })
  }
  private instant = true
  private dynamicTooltip = false
  getValue() {
    return this.sliderEl.valueAsNumber
  }
  setValue(value: number): this {
    this.sliderEl.valueAsNumber = value
    if (this.dynamicTooltip) this.sliderEl.title = String(value)
    return this
  }
  setLimits(
    min: number | null,
    max: number | null,
    step: number | 'any',
  ): this {
    for (const [name, value] of [
      ['min', min],
      ['max', max],
    ] as const)
      if (value === null) this.sliderEl.removeAttribute(name)
      else this.sliderEl.setAttribute(name, String(value))
    this.sliderEl.step = String(step)
    return this
  }
  setDynamicTooltip(): this {
    this.dynamicTooltip = true
    this.sliderEl.title = this.sliderEl.value
    return this
  }
  setInstant(instant: boolean): this {
    this.instant = instant
    return this
  }
  onChange(callback: (value: number) => unknown): this {
    this.changed = callback
    return this
  }
}

export class ColorComponent extends BaseComponent {
  colorPickerEl: HTMLInputElement
  private changed: (value: string) => unknown = () => {}
  constructor(container: HTMLElement) {
    const element = childElement(container, 'input')
    element.type = 'color'
    super(element)
    this.colorPickerEl = element
    listen(element, 'input', () => this.changed(this.getValue()))
  }
  getValue() {
    return this.colorPickerEl.value
  }
  setValue(value: string): this {
    this.colorPickerEl.value = value
    return this
  }
  getValueRgb() {
    const hex = this.getValue().slice(1)
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    }
  }
  setValueRgb({ r, g, b }: { r: number; g: number; b: number }): this {
    return this.setValue(
      '#' +
        [r, g, b]
          .map((value) =>
            Math.max(0, Math.min(255, Math.round(value)))
              .toString(16)
              .padStart(2, '0'),
          )
          .join(''),
    )
  }
  getValueHsl() {
    const rgb = this.getValueRgb()
    const r = rgb.r / 255,
      g = rgb.g / 255,
      b = rgb.b / 255
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b)
    const delta = max - min,
      light = (max + min) / 2
    const hue = !delta
      ? 0
      : max === r
        ? ((g - b) / delta) % 6
        : max === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4
    return {
      h: Math.round((hue * 60 + 360) % 360),
      s: Math.round(delta ? (delta / (1 - Math.abs(2 * light - 1))) * 100 : 0),
      l: Math.round(light * 100),
    }
  }
  setValueHsl({ h, s, l }: { h: number; s: number; l: number }): this {
    const hue = (((h % 360) + 360) % 360) / 60
    const saturation = Math.max(0, Math.min(100, s)) / 100
    const light = Math.max(0, Math.min(100, l)) / 100
    const chroma = (1 - Math.abs(2 * light - 1)) * saturation
    const x = chroma * (1 - Math.abs((hue % 2) - 1))
    const [r = 0, g = 0, b = 0] =
      hue < 1
        ? [chroma, x, 0]
        : hue < 2
          ? [x, chroma, 0]
          : hue < 3
            ? [0, chroma, x]
            : hue < 4
              ? [0, x, chroma]
              : hue < 5
                ? [x, 0, chroma]
                : [chroma, 0, x]
    const offset = light - chroma / 2
    return this.setValueRgb({
      r: (r + offset) * 255,
      g: (g + offset) * 255,
      b: (b + offset) * 255,
    })
  }
  onChange(callback: (value: string) => unknown): this {
    this.changed = callback
    return this
  }
}

export class SearchComponent extends TextComponent {
  clearButtonEl: HTMLButtonElement
  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled)
    this.clearButtonEl.disabled = disabled
    return this
  }
  constructor(container: HTMLElement) {
    super(container)
    this.inputEl.type = 'search'
    this.clearButtonEl = childElement(container, 'button')
    this.clearButtonEl.type = 'button'
    this.clearButtonEl.textContent = 'Clear'
    this.clearButtonEl.setAttribute('aria-label', 'Clear search')
    listen(this.clearButtonEl, 'click', () => {
      this.setValue('')
      this.onChanged()
      this.inputEl.focus()
    })
  }
}

export class MomentFormatComponent extends TextComponent {
  sampleEl: HTMLElement
  private defaultFormat = 'YYYY-MM-DD'
  constructor(container: HTMLElement) {
    super(container)
    this.sampleEl = childElement(container, 'span')
    this.updateSample()
  }
  setDefaultFormat(format: string): this {
    this.defaultFormat = format
    this.setPlaceholder(format)
    this.updateSample()
    return this
  }
  setSampleEl(element: HTMLElement): this {
    this.sampleEl = element
    this.updateSample()
    return this
  }
  override setValue(value: string): this {
    super.setValue(value)
    this.updateSample()
    return this
  }
  override onChanged() {
    super.onChanged()
    this.updateSample()
  }
  updateSample(): void {
    const date = new Date()
    const pad = (value: number) => String(value).padStart(2, '0')
    const tokens: Record<string, string> = {
      YYYY: String(date.getFullYear()),
      YY: String(date.getFullYear()).slice(-2),
      MM: pad(date.getMonth() + 1),
      M: String(date.getMonth() + 1),
      DD: pad(date.getDate()),
      D: String(date.getDate()),
      HH: pad(date.getHours()),
      H: String(date.getHours()),
      mm: pad(date.getMinutes()),
      m: String(date.getMinutes()),
      ss: pad(date.getSeconds()),
      s: String(date.getSeconds()),
    }
    // ponytail: date/time token preview only; add moment if it becomes a host dependency.
    this.sampleEl.textContent = (this.getValue() || this.defaultFormat).replace(
      /\[([^\]]*)\]|YYYY|YY|MM|DD|HH|mm|ss|M|D|H|m|s/g,
      (match, literal: string | undefined) => literal ?? tokens[match] ?? match,
    )
  }
}

let nextSetting = 0
export class Setting {
  settingEl: HTMLDivElement
  infoEl: HTMLDivElement
  nameEl: HTMLDivElement
  descEl: HTMLDivElement
  controlEl: HTMLDivElement
  errorEl: HTMLDivElement | null = null
  components: BaseComponent[] = []
  private disabled = false
  constructor(container: HTMLElement) {
    this.settingEl = childElement(container, 'div', 'setting-item')
    this.infoEl = childElement(this.settingEl, 'div', 'setting-item-info')
    this.nameEl = childElement(this.infoEl, 'div', 'setting-item-name')
    this.descEl = childElement(this.infoEl, 'div', 'setting-item-description')
    this.descEl.id = `obsidian-setting-${++nextSetting}`
    this.controlEl = childElement(this.settingEl, 'div', 'setting-item-control')
  }
  setName(value: string | DocumentFragment): this {
    this.nameEl.replaceChildren(value)
    this.labelControls()
    return this
  }
  setDesc(value: string | DocumentFragment): this {
    this.descEl.replaceChildren(value)
    return this
  }
  setClass(cls: string): this {
    this.settingEl.classList.add(...cls.split(/\s+/).filter(Boolean))
    return this
  }
  setTooltip(text: string): this {
    this.nameEl.title = text
    return this
  }
  setHeading(): this {
    this.nameEl.setAttribute('role', 'heading')
    this.nameEl.setAttribute('aria-level', '3')
    return this.setClass('setting-item-heading')
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled
    for (const component of this.components) component.setDisabled(disabled)
    return this
  }
  setErrorMessage(message: string | null): this {
    this.errorEl?.remove()
    this.errorEl = null
    if (message) {
      this.errorEl = childElement(this.infoEl, 'div', 'setting-item-error')
      this.errorEl.textContent = message
      this.errorEl.setAttribute('role', 'alert')
    }
    this.settingEl.classList.toggle('is-invalid', !!message)
    return this
  }
  // biome-ignore lint/suspicious/noThenProperty: Obsidian's synchronous fluent API is named then.
  then(callback: (setting: this) => unknown): this {
    callback(this)
    return this
  }
  private labelControls() {
    for (const component of this.components) {
      if (
        !(
          component.element instanceof HTMLButtonElement &&
          component.element.textContent?.trim()
        ) &&
        !component.element.getAttribute('aria-label')
      )
        component.element.setAttribute(
          'aria-label',
          this.nameEl.textContent ?? '',
        )
      component.element.setAttribute('aria-describedby', this.descEl.id)
    }
  }
  addComponent<T extends BaseComponent>(
    create: (container: HTMLElement) => T,
  ): this {
    const component = create(this.controlEl)
    this.components.push(component)
    if (this.disabled) component.setDisabled(true)
    this.labelControls()
    return this
  }
  addButton(callback: (component: ButtonComponent) => unknown): this {
    return this.addComponent((el) => new ButtonComponent(el).then(callback))
  }
  addExtraButton(callback: (component: ExtraButtonComponent) => unknown): this {
    return this.addComponent((el) =>
      new ExtraButtonComponent(el).then(callback),
    )
  }
  addToggle(callback: (component: ToggleComponent) => unknown): this {
    return this.addComponent((el) => new ToggleComponent(el).then(callback))
  }
  addText(callback: (component: TextComponent) => unknown): this {
    return this.addComponent((el) => new TextComponent(el).then(callback))
  }
  addTextArea(callback: (component: TextAreaComponent) => unknown): this {
    return this.addComponent((el) => new TextAreaComponent(el).then(callback))
  }
  addDropdown(callback: (component: DropdownComponent) => unknown): this {
    return this.addComponent((el) => new DropdownComponent(el).then(callback))
  }
  addSlider(callback: (component: SliderComponent) => unknown): this {
    return this.addComponent((el) => new SliderComponent(el).then(callback))
  }
  addColorPicker(callback: (component: ColorComponent) => unknown): this {
    return this.addComponent((el) => new ColorComponent(el).then(callback))
  }
  addSearch(callback: (component: SearchComponent) => unknown): this {
    return this.addComponent((el) => new SearchComponent(el).then(callback))
  }
  addMomentFormat(
    callback: (component: MomentFormatComponent) => unknown,
  ): this {
    return this.addComponent((el) =>
      new MomentFormatComponent(el).then(callback),
    )
  }
}
