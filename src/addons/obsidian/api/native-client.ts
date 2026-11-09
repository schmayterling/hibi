/**
 * Uses Hibi's guarded profile channel without entering the note/file operation queue.
 * Capabilities cross this call, so it reads contextBridge's frozen, non-configurable
 * `hibiTransport`, never the page-replaceable `window.hibi` methods.
 */
export async function invokeObsidianProfile<T = unknown>(
  method: string,
  input: unknown,
): Promise<T> {
  return (await window.hibiTransport.invokeAddonProfile(
    'obsidian',
    method,
    input,
  )) as T
}
