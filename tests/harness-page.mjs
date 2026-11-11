/**
 * The page a test writes for a window to load its bundled script. It says
 * utf-8: a page without a charset reads its scripts as windows-1252, and
 * bundled data with non-ASCII text decodes to something else (#1022).
 * tests/harness-pages.test.mjs keeps every such page coming from here.
 */
export function harnessPage({ script = 'harness.js', css, head = '' } = {}) {
  const style = css ? `<link rel="stylesheet" href="${css}">` : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${style}${head}</head><body><script src="${script}"></script></body></html>`
}
