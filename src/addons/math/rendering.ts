/** Expressions kept rendered; evicted ones render again when they next mount. */
const cachedFormulas = 4096
/** Milliseconds of rendering per frame or visibility change, and per idle slice under load. */
const budget = 8

type Render = (latex: string, display: boolean) => string
type Formula = {
  latex: string
  display: boolean
  done: (html: string | null) => void
}

/** Rendered HTML by expression and display mode; one cache uses one set of options and macros. */
export function formulaCache(render: Render): Render {
  const cache = new Map<string, string>()
  return (latex, display) => {
    const key = `${display ? 'display' : 'inline'}:${latex}`
    let html = cache.get(key)
    if (html === undefined) {
      html = render(latex, display)
      if (cache.size >= cachedFormulas)
        cache.delete(cache.keys().next().value as string)
    } else cache.delete(key)
    cache.set(key, html)
    return html
  }
}

/**
 * Formulas render after mounting: those on screen before the next paint, then
 * newly visible ones, then the rest in idle slices, so opening a note never
 * renders every expression before accepting input.
 */
export function formulaScheduler(render: Render) {
  const html = formulaCache(render)
  const queued = new Map<Element, Formula>()
  const visible = new Set<Element>()
  let frame = 0
  let idle = 0
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        if (entry.isIntersecting) visible.add(entry.target)
        else visible.delete(entry.target)
      if (visible.size) work(visible)
    },
    { rootMargin: '50% 0px' },
  )
  const cancel = (element: Element) => {
    queued.delete(element)
    visible.delete(element)
    observer.unobserve(element)
  }
  /** Renders `elements` in order until the budget is spent; at least one makes progress. */
  function work(elements: Iterable<Element>, time = budget) {
    const end = performance.now() + time
    for (const element of [...elements]) {
      const formula = queued.get(element)
      if (!formula) continue
      cancel(element)
      let result: string | null = null
      try {
        result = html(formula.latex, formula.display)
      } catch {
        // The node shows its source, as before when KaTeX threw.
      }
      formula.done(result)
      if (performance.now() >= end) break
    }
    later()
  }
  // Idle slices are separate tasks, so input runs between them.
  function later() {
    if (!queued.size || idle) return
    idle = requestIdleCallback(
      (deadline) => {
        idle = 0
        // Fewer, longer slices while idle mean fewer layouts of the whole note.
        work(
          [...visible, ...queued.keys()],
          deadline.didTimeout ? budget / 2 : deadline.timeRemaining(),
        )
      },
      { timeout: 1000 },
    )
  }
  return {
    render: html,
    /** Queues a formula for `element`; the returned function cancels it. */
    schedule(
      element: Element,
      latex: string,
      display: boolean,
      done: Formula['done'],
    ) {
      queued.set(element, { latex, display, done })
      observer.observe(element)
      later()
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0
          const height = window.innerHeight
          work(
            [...queued.keys()].filter((element) => {
              const box = element.getBoundingClientRect()
              return box.bottom > 0 && box.top < height
            }),
          )
        })
      return () => cancel(element)
    },
  }
}
