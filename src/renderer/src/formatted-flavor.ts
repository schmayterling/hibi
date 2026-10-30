import { type EditorView, WidgetType } from '@codemirror/view'
import type {
  FormattedDecorations,
  FormattedLayout,
  FormattedNode,
  FormattedNodeView,
  FormattedRenderContext,
  MarkdownFlavor,
} from '../../addons/api'
import { errorMessage } from '../../shared/errors'
import { flavorSyntax } from './flavor-syntax'
import { formattedRegistry } from './formatted-registry'

type Attempt = <Result>(run: () => Result) => Result | undefined
type Own = (widget: WidgetType) => WidgetType

/** An addon's widget runs in its owner's guard: a failure removes the owner, not the editor's drawing. */
class OwnedWidget extends WidgetType {
  constructor(
    readonly widget: WidgetType,
    readonly attempt: Attempt,
    /** Runs even after the owner failed, so its widgets release what they hold. */
    readonly release: (run: () => void) => void,
  ) {
    super()
  }
  eq(other: OwnedWidget) {
    return (
      this.widget === other.widget ||
      (this.widget.constructor === other.widget.constructor &&
        this.attempt(() => this.widget.eq(other.widget)) === true)
    )
  }
  toDOM(view: EditorView) {
    return (
      this.attempt(() => {
        const dom = this.widget.toDOM(view)
        if (!(dom instanceof HTMLElement))
          throw new TypeError('A formatted widget must draw an HTML element.')
        return dom
      }) ?? document.createElement('span')
    )
  }
  updateDOM(dom: HTMLElement, view: EditorView, from: this) {
    return (
      this.widget.constructor === from.widget.constructor &&
      this.attempt(() => this.widget.updateDOM(dom, view, from.widget)) === true
    )
  }
  get estimatedHeight() {
    return (
      this.attempt(() => {
        const height = this.widget.estimatedHeight
        if (!Number.isFinite(height) || height < -1)
          throw new RangeError('A formatted widget height must be -1 or more.')
        return height
      }) ?? -1
    )
  }
  get lineBreaks() {
    return (
      this.attempt(() => {
        const breaks = this.widget.lineBreaks
        if (!Number.isInteger(breaks) || breaks < 0)
          throw new RangeError('Formatted widget line breaks must be a count.')
        return breaks
      }) ?? 0
    )
  }
  ignoreEvent(event: Event) {
    return this.attempt(() => this.widget.ignoreEvent(event)) ?? true
  }
  coordsAt(dom: HTMLElement, pos: number, side: number) {
    return this.attempt(() => this.widget.coordsAt(dom, pos, side)) ?? null
  }
  destroy(dom: HTMLElement) {
    this.release(() => this.widget.destroy(dom))
  }
}

/** A range the renderer can keep: whole positions, in order, from `min` to `max`. */
function checkRange(
  from: number,
  to: number,
  min: number,
  max: number,
  message: string,
) {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < min ||
    to < from ||
    to > max
  )
    throw new RangeError(message)
}
function checkSide(side: number | undefined) {
  if (side !== undefined && side !== -1 && side !== 1)
    throw new RangeError('A formatted widget side must be -1 or 1.')
}
const attributeNames = new Set<string>()
/** Attributes the view cannot set would fail while it draws, outside the owner's guard. */
function checkedAttributes(attributes: Record<string, string>) {
  for (const [name, value] of Object.entries(attributes)) {
    if (typeof value !== 'string')
      throw new TypeError('Formatted attribute values must be strings.')
    if (attributeNames.has(name)) continue
    document.createElement('span').setAttribute(name, '')
    attributeNames.add(name)
  }
  return attributes
}

/** Addon decorations are checked before the shared renderer keeps them. */
function checkedDecorations(
  out: FormattedDecorations,
  context: FormattedRenderContext,
  own: Own,
): FormattedDecorations {
  const range = (from: number, to: number) =>
    checkRange(
      from,
      to,
      0,
      context.state.doc.length,
      'Formatted output must stay in order inside the document.',
    )
  const oneLine = (from: number, to: number) => {
    range(from, to)
    if (to > context.state.doc.lineAt(from).to)
      throw new RangeError(
        'Formatted syntax and replacements stay on one line.',
      )
  }
  return {
    mark(from, to, attributes) {
      range(from, to)
      out.mark(from, to, checkedAttributes(attributes))
    },
    link(from, to, attributes) {
      range(from, to)
      out.link(
        from,
        to,
        attributes === undefined ? undefined : checkedAttributes(attributes),
      )
    },
    syntax(from, to) {
      oneLine(from, to)
      out.syntax(from, to)
    },
    line(at, attributes) {
      range(at, at)
      if (context.state.doc.lineAt(at).from !== at)
        throw new RangeError('Formatted line attributes start at a line.')
      out.line(at, checkedAttributes(attributes))
    },
    widget(at, widget, side) {
      range(at, at)
      checkSide(side)
      out.widget(at, own(widget), side)
    },
    replace(from, to, widget) {
      oneLine(from, to)
      out.replace(from, to, widget === undefined ? undefined : own(widget))
    },
  }
}

/** Layout is kept per parsed chunk, so it stays on its node's lines. */
function checkedLayout(
  out: FormattedLayout,
  node: FormattedNode,
  context: FormattedRenderContext,
  own: Own,
): FormattedLayout {
  const { from: start, to: end } = node
  const inside = (from: number, to: number) => {
    const { doc } = context.state
    checkRange(
      from,
      to,
      doc.lineAt(start).from,
      doc.lineAt(end).to,
      "Formatted layout must stay in order on its node's lines.",
    )
  }
  return {
    replace(from, to, widget, options) {
      inside(from, to)
      out.replace(
        from,
        to,
        widget === undefined ? undefined : own(widget),
        options,
      )
    },
    widget(at, widget, options) {
      inside(at, at)
      checkSide(options?.side)
      out.widget(at, own(widget), options)
    },
  }
}

/** Public flavors use the same lazy contribution registry as bundled features. */
export function registerFormattedFlavor(
  addonId: string,
  flavor: MarkdownFlavor,
  onError: (error: unknown) => void,
) {
  const id = flavor.id.startsWith(`${addonId}.`)
    ? flavor.id
    : `${addonId}.${flavor.id}`
  const syntax = flavorSyntax(flavor)
  let failed = false
  let remove = () => {}
  /** The owner's first failure removes it and is reported; later ones are not. */
  const fail = (error: unknown) => {
    if (failed) return
    failed = true
    queueMicrotask(() => {
      remove()
      onError(new Error(`${id}: ${errorMessage(error)}`, { cause: error }))
    })
  }
  const attempt: Attempt = (run) => {
    if (failed) return
    try {
      return run()
    } catch (error) {
      fail(error)
    }
  }
  const release = (run: () => void) => {
    try {
      run()
    } catch (error) {
      fail(error)
    }
  }
  const guard =
    <Args extends unknown[], Result>(callback: (...args: Args) => Result) =>
    (...args: Args) =>
      attempt(() => callback(...args))
  const own: Own = (widget) => {
    if (!(widget instanceof WidgetType))
      throw new TypeError('Formatted widgets must extend WidgetType.')
    return new OwnedWidget(widget, attempt, release)
  }
  remove = formattedRegistry.register({
    id: `flavor:${id}`,
    load: () => ({
      id,
      flavor: id,
      ...(syntax ? { syntax } : {}),
      ...(flavor.inlineStops ? { inlineStops: true } : {}),
      views:
        flavor.render?.map((view): FormattedNodeView => {
          const { decorate, layout } = view
          const container = view.container && guard(view.container)
          return {
            ...view,
            ...(decorate
              ? {
                  decorate: guard(
                    (
                      node: FormattedNode,
                      out: FormattedDecorations,
                      context: FormattedRenderContext,
                    ) =>
                      decorate(
                        node,
                        checkedDecorations(out, context, own),
                        context,
                      ),
                  ),
                }
              : {}),
            ...(layout
              ? {
                  layout: guard(
                    (
                      node: FormattedNode,
                      out: FormattedLayout,
                      context: FormattedRenderContext,
                    ) =>
                      layout(
                        node,
                        checkedLayout(out, node, context, own),
                        context,
                      ),
                  ),
                }
              : {}),
            ...(container
              ? {
                  container(node, context) {
                    const shape = container(node, context)
                    if (!shape?.paint) return shape
                    const paint = guard(shape.paint)
                    return {
                      ...shape,
                      paint: (left, top, right, bottom) =>
                        paint(left, top, right, bottom) ?? '',
                    }
                  },
                }
              : {}),
            ...(view.feature ? { feature: `${addonId}.${view.feature}` } : {}),
          }
        }) ?? [],
    }),
  })
  return remove
}
