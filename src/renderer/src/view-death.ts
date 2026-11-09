/**
 * Views whose redraw failed: CodeMirror has dropped their plugins and content
 * by then, so they can show nothing more, and each further redraw starts their
 * plugins' work over. The session keeps what they accepted. It also takes the
 * failure of an update made for its edit, so whoever dispatched never hears of
 * it: a listener does.
 */
export const deadViews = new WeakSet<object>()
export const isViewDead = (view: object) => deadViews.has(view)
