/** Views whose redraw failed (see source-session.ts). */
export const deadViews = new WeakSet<object>()
export const isViewDead = (view: object) => deadViews.has(view)
