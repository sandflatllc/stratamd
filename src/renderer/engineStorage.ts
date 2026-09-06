let identity = ''
let original = ''
export function setEngineStorageIdentity(next: string | undefined): void {
  identity = next ?? ''
  original = localStorage.getItem('stratamd.original-engine') ?? ''
  if (!original && identity) { original = identity; localStorage.setItem('stratamd.original-engine', original) }
}
export function engineStorageKey(key: string): string { return !identity || identity === original ? key : `engine:${identity}:${key}` }
export const engineStorage = {
  getItem(key: string): string | null { return localStorage.getItem(engineStorageKey(key)) },
  setItem(key: string, value: string): void { localStorage.setItem(engineStorageKey(key), value) },
  removeItem(key: string): void { localStorage.removeItem(engineStorageKey(key)) },
  get length(): number { return localStorage.length },
  key(index: number): string | null {
    const key = localStorage.key(index)
    if (!key) return null
    const prefix = engineStorageKey('')
    return prefix ? key.startsWith(prefix) ? key.slice(prefix.length) : null : key.startsWith('engine:') ? null : key
  },
}
