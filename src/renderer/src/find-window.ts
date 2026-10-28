export type FindRange = { from: number; to: number }

/**
 * Positions at the starts of the top and bottom lines visible in `dom`, as
 * `at` reads a DOM point, or null where it has no document position.
 */
export function visibleRange(
  dom: HTMLElement,
  at: (node: Node, offset: number) => number | null,
): FindRange | null {
  const box = dom.getBoundingClientRect()
  let top = Math.max(box.top, 0)
  let bottom = Math.min(box.bottom, window.innerHeight)
  // Scrolling panes and other clipping ancestors bound what is visible.
  for (
    let element = dom.parentElement;
    element;
    element = element.parentElement
  )
    if (getComputedStyle(element).overflowY !== 'visible') {
      const clip = element.getBoundingClientRect()
      top = Math.max(top, clip.top)
      bottom = Math.min(bottom, clip.bottom)
    }
  if (top >= bottom) return null
  // Hit-test at the start of lines: a point past a line's end can resolve to
  // the end of its block.
  const left =
    box.left + Number.parseFloat(getComputedStyle(dom).paddingLeft) + 1
  const position = (y: number, step: number) => {
    // Overlays such as the find bar can cover a point, so look past them.
    for (let tries = 0; tries < 8 && y > top && y < bottom; tries++) {
      const caret = document.caretPositionFromPoint(left, y)
      if (caret && dom.contains(caret.offsetNode)) {
        const found = at(caret.offsetNode, caret.offset)
        if (found !== null) return found
      }
      y += step
    }
    return null
  }
  const from = position(top + 1, 24)
  const to = position(bottom - 1, -24)
  return from === null || to === null || from > to ? null : { from, to }
}

/** About a screen of text on each side of `visible` keeps scrolling ahead of updates. */
export function findWindow(visible: FindRange, size: number): FindRange {
  const margin = Math.max(visible.to - visible.from, 2000)
  return {
    from: Math.max(0, visible.from - margin),
    to: Math.min(size, visible.to + margin),
  }
}
