import type { WorkspacePage } from '../../shared/workspace'

export async function preparePages(
  pages: Iterable<WorkspacePage> | AsyncIterable<WorkspacePage>,
  render: (page: WorkspacePage) => Promise<{ html: string; css: string }>,
  stage: (page: WorkspacePage & { html: string }) => Promise<void>,
  signal?: AbortSignal,
) {
  const styles = new Set<string>()
  let cssBytes = 0
  for await (const page of pages) {
    signal?.throwIfAborted()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    signal?.throwIfAborted()
    const rendered = await render(page)
    signal?.throwIfAborted()
    if (rendered.css && !styles.has(rendered.css)) {
      cssBytes +=
        new TextEncoder().encode(rendered.css).byteLength +
        (styles.size ? 1 : 0)
      if (cssBytes > 2 * 1024 * 1024)
        throw new Error('Could not prepare the documentation export.')
      styles.add(rendered.css)
    }
    await stage({ ...page, html: rendered.html })
  }
  signal?.throwIfAborted()
  return [...styles].join('\n')
}
