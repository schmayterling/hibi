/** A reference label as the tokenizer matches it to definitions. */
export const referenceLabel = (label: string) =>
  label.replace(/\s+/g, ' ').trim().toLowerCase().toUpperCase().toLowerCase()
