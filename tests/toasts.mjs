/**
 * Toasts dismiss themselves, sometimes before a failing wait ends. Record the
 * latest distinct messages until the returned function stops the recorder and
 * returns them.
 */
export async function recordToasts(page, limit = 8) {
  await page.evaluate((limit) => {
    window.hibiToastRecorder?.observer.disconnect()
    const entries = []
    const observer = new MutationObserver(() => {
      for (const toast of document.querySelectorAll('.toast-copy')) {
        const entry = `${toast.getAttribute('role')}: ${toast.textContent?.slice(0, 200)}`
        if (entries.includes(entry)) continue
        if (entries.length === limit) entries.shift()
        entries.push(entry)
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    window.hibiToastRecorder = { entries, observer }
  }, limit)
  return () =>
    page.evaluate(() => {
      const recorder = window.hibiToastRecorder
      if (!recorder) return []
      recorder.observer.disconnect()
      delete window.hibiToastRecorder
      return recorder.entries
    })
}
