import { useEffect, useState, useRef, type ReactNode } from 'react'
import { setEngineStorageIdentity } from './engineStorage'

/** Recreate conversation UI state after changing engines, before any old draft can target the new one. */
export function EngineScope({ children }: { children: ReactNode }) {
  const [scope, setScope] = useState<string | null>(null)
  const selected = useRef<string | null>(null)
  const reloading = useRef(false)
  useEffect(() => {
    let live = true
    const select = (identity: string | undefined) => {
      if (!live) return
      const next = identity ?? ''
      if (selected.current !== null && selected.current !== next) {
        if (!reloading.current) { reloading.current = true; window.location.reload() }
        return
      }
      selected.current = next
      setEngineStorageIdentity(identity)
      setScope(next)
    }
    let received = false
    const unsubscribe = window.strata.subscribe(view => { received = true; select(view.engine.identity) })
    void window.strata.getState().then(view => { if (!received) select(view.engine.identity) })
    return () => { live = false; unsubscribe() }
  }, [])
  return scope === null ? null : <div key={scope} style={{ display: 'contents' }}>{children}</div>
}
