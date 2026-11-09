/** Uses Hibi's guarded profile channel without entering the note/file operation queue. */
export async function invokeObsidianProfile<T = unknown>(
  method: string,
  input: unknown,
): Promise<T> {
  return (await window.hibi.invokeAddonProfile('obsidian', method, input)) as T
}
