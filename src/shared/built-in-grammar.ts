/**
 * Built-in grammar that hibi's own parsers were audited to model exactly: the
 * source outline, source references, native semantics, workspace metadata,
 * the strict visual proof and the plain visual typing codec. Flavors are keyed
 * by registered id and belong to `owner`. Callers also require the owner to be
 * a built-in addon, so an addon's own declarations never enable these paths.
 * A default-on flavor missing here turns them off for every note.
 *
 * Every listed flavor keeps Marked's block boundaries and has a detector that
 * needs punctuation, which letter, digit and space edits cannot add.
 */
export const builtInFlavors: ReadonlyMap<
  string,
  Readonly<{
    owner: string
    /** False when the flavor changes paragraph text, so plain typing cannot be certified. */
    plainText?: false
  }>
> = new Map([
  ['markdown.github', { owner: 'markdown' }],
  ['markdown.obsidian', { owner: 'markdown' }],
  ['text-extras.text-extras', { owner: 'text-extras' }],
  // Inline and display math have their own paragraph proof.
  ['math.latex', { owner: 'math', plainText: false }],
  // Diagrams are Marked's own mermaid code blocks.
  ['mermaid.blocks', { owner: 'mermaid' }],
])

/** Syntax features the workspace metadata parser models. */
export const builtInFeatures =
  /^(?:core\.(?:heading-[1-6]|bold|italic|inline-code|escapes|code-blocks|quotes|bullet-lists|numbered-lists|dividers|line-breaks|links|images|html-blocks|inline-html)|markdown\.(?:tables|tasks|strike|alerts)|math\.(?:inline|block)|text-extras\.(?:subscript|subtext)|mermaid\.(?:blocks|preview))$/

/** Rich attachments that observe or dispatch edits without changing the parsed document. */
export const builtInRichAttachments: ReadonlyMap<string, string> = new Map([
  ['word-count.text', 'word-count'],
  ['block-drag.handle', 'block-drag'],
  ['dictionary.lookup', 'dictionary'],
  ['math.editing', 'math'],
  ['slash-commands.menu', 'slash-commands'],
  ['tags.highlights', 'tags'],
])
