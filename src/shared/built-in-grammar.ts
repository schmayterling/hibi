/**
 * Built-in grammar that hibi's own parsers were audited to model exactly: the
 * source outline, source references and workspace metadata. Flavors are keyed
 * by registered id and belong to `owner`. Callers also require the owner to be
 * a built-in addon, so an addon's own declarations never enable these paths.
 * A default-on flavor missing here turns them off for every note.
 *
 * Every listed flavor keeps Marked's block boundaries and has a detector that
 * needs punctuation, which letter, digit and space edits cannot add.
 */
export const builtInFlavors: ReadonlyMap<
  string,
  Readonly<{ owner: string }>
> = new Map([
  ['markdown.github', { owner: 'markdown' }],
  ['markdown.obsidian', { owner: 'markdown' }],
  ['text-extras.text-extras', { owner: 'text-extras' }],
  ['math.latex', { owner: 'math' }],
  // Diagrams are Marked's own mermaid code blocks.
  ['mermaid.blocks', { owner: 'mermaid' }],
])

/** Syntax features the workspace metadata parser models. */
export const builtInFeatures =
  /^(?:core\.(?:heading-[1-6]|bold|italic|inline-code|escapes|code-blocks|quotes|bullet-lists|numbered-lists|dividers|line-breaks|links|images|html-blocks|inline-html)|markdown\.(?:tables|tasks|strike|alerts)|math\.(?:inline|block)|text-extras\.(?:subscript|subtext)|mermaid\.(?:blocks|preview))$/
