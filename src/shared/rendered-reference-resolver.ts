import { builtInFlavors } from './built-in-grammar.ts'
import { FrontmatterParser } from './frontmatter-parser.ts'
import type { BoundaryConfig } from './markdown-boundary-syntax.ts'
import { boundaryParser } from './markdown-boundary-syntax.ts'
import { MarkdownSourceModel } from './markdown-source-model.ts'
import { MarkdownSourceReferences } from './markdown-source-references.ts'
import { UnsupportedRenderedFind } from './rendered-text.ts'
import type { SourceSnapshot } from './source-buffer.ts'

export function renderedReferenceSyntax(config: BoundaryConfig) {
  return {
    gfm: config.flavors.includes('markdown.github'),
    alerts: config.flavors.includes('markdown.github'),
    textExtras: config.flavors.includes('text-extras.text-extras'),
    math: config.flavors.includes('math.latex'),
  }
}

/** Reuse reference semantics over the worker's immutable source, without another replica. */
export function* prepareRenderedReferences(
  source: SourceSnapshot,
  config: BoundaryConfig,
): Generator<void, MarkdownSourceReferences> {
  if (config.flavors.some((id) => !builtInFlavors.has(id)))
    throw new UnsupportedRenderedFind()
  const parser = boundaryParser({
    ...config,
    syntax: config.textSyntax ?? config.syntax,
  })
  if (!parser) throw new UnsupportedRenderedFind()
  const model = new MarkdownSourceModel(
    source,
    config.prefix ? new FrontmatterParser(parser, config.prefix) : parser,
    'rendered-references',
  )
  const references = new MarkdownSourceReferences(
    renderedReferenceSyntax(config),
  )
  let complete = false
  try {
    while (!model.advance().complete) yield
    yield* references.update(source, model.state().owners!)
    complete = true
    return references
  } finally {
    model.dispose()
    if (!complete) references.dispose()
  }
}
