/** Detach retained text from sliced/concatenated parents without changing UTF-16 units. */
export function ownSourceText(text: string): string {
  // V8 makes sliced and cons strings only from 13 units up, so shorter text
  // is already flat and owns its units; a 16k-line Tab sends 16k one-unit inserts.
  return text.length < 13 ? text : structuredClone(text)
}
