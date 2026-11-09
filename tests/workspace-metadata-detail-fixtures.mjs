export const fixturePosition = {
  start: { line: 0, col: 0, offset: 0 },
  end: { line: 0, col: 1, offset: 1 },
}
export const withoutPositions = (page) => ({
  ...page,
  items: page.items.map(({ position, ...heading }) => heading),
})

/** Replace only the worker's entry generator; retain its real parser and stores. */
export function metadataWorkerFixture(
  patch,
  before = '',
  worker = new URL('../src/main/workspace-metadata-worker.ts', import.meta.url)
    .href,
) {
  const parser = new URL('../src/shared/note-cache-parser.ts', import.meta.url)
    .href
  const injection = `const fixturePosition = ${JSON.stringify(fixturePosition)}\n${patch}`
  return [
    "import { registerHooks } from 'node:module'",
    before,
    `const patch = ${JSON.stringify(injection)}`,
    'registerHooks({ load(url, context, next) {',
    '  const result = next(url, context)',
    `  if (url !== ${JSON.stringify(parser)}) return result`,
    '  const source = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source)',
    '  return { ...result, source: source.replace("export function* noteCacheEntries(", "function* actualNoteCacheEntries(") + "\\n" + patch }',
    '} })',
    `await import(${JSON.stringify(worker)})`,
  ].join('\n')
}
