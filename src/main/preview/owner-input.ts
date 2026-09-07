const listeners = new Set<() => void>()
export function reportPreviewOwnerInput(): void { for (const listener of listeners) listener() }
export function subscribePreviewOwnerInput(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
