const active = new Map<number, Set<AbortController>>()

export function cancelImport(windowId: number): void {
  for (const controller of active.get(windowId) ?? []) controller.abort()
}
export async function runCancellableImport<T>(
  windowId: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
  const controller = new AbortController()
  const controllers = active.get(windowId) ?? new Set<AbortController>()
  controllers.add(controller)
  active.set(windowId, controllers)
  try {
    return await operation(controller.signal)
  } catch (error) {
    if (
      controller.signal.aborted &&
      error instanceof Error &&
      error.name === 'AbortError'
    )
      return null
    throw error
  } finally {
    controllers.delete(controller)
    if (!controllers.size) active.delete(windowId)
  }
}
