import type { WorkspaceEntry, WorkspacePage } from '../../shared/workspace'

export function exportPaths(
  entries: readonly WorkspaceEntry[],
): { path: string }[] {
  return entries.flatMap((entry) =>
    entry.children
      ? exportPaths(entry.children)
      : entry.kind === 'file'
        ? [{ path: entry.path }]
        : [],
  )
}

export async function preparePages(
  pages: Iterable<WorkspacePage> | AsyncIterable<WorkspacePage>,
  render: (page: WorkspacePage) => Promise<{ html: string; css: string }>,
  stage: (page: WorkspacePage & { html: string }) => Promise<void>,
  signal?: AbortSignal,
) {
  const styles = new Set<string>()
  for await (const page of pages) {
    signal?.throwIfAborted()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    signal?.throwIfAborted()
    const rendered = await render(page)
    signal?.throwIfAborted()
    if (rendered.css) styles.add(rendered.css)
    await stage({ ...page, html: rendered.html })
  }
  signal?.throwIfAborted()
  return [...styles].join('\n')
}
