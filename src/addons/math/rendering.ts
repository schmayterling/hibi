/** Characters of expressions and output kept; evicted ones render again when they next mount. */
const cachedCharacters = 8_000_000
/** Larger outputs still render, but on every mount, so they cannot crowd out the rest. */
const largestCached = cachedCharacters / 16
/** Milliseconds of rendering per frame or visibility change, and per idle slice under load. */
const budget = 8

type Render = (latex: string, display: boolean) => string
type Formula = {
  latex: string
  display: boolean
  done: (html: string | null) => void
}
type Rendered = { html: string; height?: number }

/** Rendered HTML by expression and display mode; one cache uses one set of options and macros. */
export function formulaCache(render: Render) {
  const cache = new Map<string, Rendered>()
  let characters = 0
  const name = (latex: string, display: boolean) =>
    `${display ? 'display' : 'inline'}:${latex}`
  return {
    render(latex: string, display: boolean) {
      const key = name(latex, display)
      const cached = cache.get(key)
      if (cached) {
        cache.delete(key)
        cache.set(key, cached)
        return cached.html
      }
      const html = render(latex, display)
      if (key.length + html.length > largestCached) return html
      cache.set(key, { html })
      characters += key.length + html.length
      for (const [oldest, entry] of cache) {
        if (characters <= cachedCharacters) break
        cache.delete(oldest)
        characters -= oldest.length + entry.html.length
      }
      return html
    },
    /** Height a display formula last rendered at, while its output is cached. */
    height: (latex: string) => cache.get(name(latex, true))?.height,
    measured(latex: string, height: number) {
      const cached = cache.get(name(latex, true))
      if (cached) cached.height = height
    },
  }
}

/**
 * Formulas render after mounting: those on screen before the next paint, then
 * newly visible ones, then the rest in idle slices, so opening a note never
 * renders every expression before accepting input.
 */
export function formulaScheduler(render: Render) {
  const cache = formulaCache(render)
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
  // Display heights arrive after layout, so render slices never force one.
  const measuring = new Map<Element, string>()
  const sizes = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const latex = measuring.get(entry.target)
      const height = entry.borderBoxSize[0]?.blockSize
      if (latex === undefined || !height) continue
      cache.measured(latex, height)
      measuring.delete(entry.target)
      sizes.unobserve(entry.target)
    }
  })
  const dequeue = (element: Element) => {
    queued.delete(element)
    visible.delete(element)
    observer.unobserve(element)
  }
  /** Renders queued formulas from `elements` until the budget is spent; at least one makes progress. */
  function work(elements: Iterable<Element>, time = budget) {
    const end = performance.now() + time
    // Iterating the live queue in place keeps each slice proportional to what it renders.
    for (const element of elements) {
      const formula = queued.get(element)
      if (!formula) continue
      dequeue(element)
      let result: string | null = null
      try {
        result = cache.render(formula.latex, formula.display)
      } catch {
        // The node shows its source, as before when KaTeX threw.
      }
      formula.done(result)
      // Remounted display formulas reserve the height they rendered at.
      if (formula.display && result !== null) {
        measuring.set(element, formula.latex)
        sizes.observe(element, { box: 'border-box' })
      }
      if (performance.now() >= end) break
    }
    later()
  }
  function* pending() {
    yield* visible
    yield* queued.keys()
  }
  // Idle slices are separate tasks, so input runs between them.
  function later() {
    if (!queued.size || idle) return
    idle = requestIdleCallback(
      (deadline) => {
        idle = 0
        // Fewer, longer slices while idle mean fewer layouts of the whole note.
        work(
          pending(),
          deadline.didTimeout ? budget / 2 : deadline.timeRemaining(),
        )
      },
      { timeout: 1000 },
    )
  }
  /** Queued formulas on screen, in document order, until one lies below it or time runs out. */
  function* onScreen(end: number) {
    const height = window.innerHeight
    for (const element of queued.keys()) {
      if (performance.now() >= end) return
      const box = element.getBoundingClientRect()
      if (box.top >= height) return
      if (box.bottom > 0) yield element
    }
  }
  return {
    render: cache.render,
    height: cache.height,
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
          work(onScreen(performance.now() + budget))
        })
      return () => {
        dequeue(element)
        measuring.delete(element)
        sizes.unobserve(element)
      }
    },
  }
}
