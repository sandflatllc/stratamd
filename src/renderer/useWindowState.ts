import { useEffect, useState } from 'react'
import type { WindowState } from '../shared/contracts'

export function useWindowState(): WindowState | null {
  const [state, setState] = useState<WindowState | null>(null)
  useEffect(() => {
    let active = true
    const receive = (next: WindowState) => {
      if (active) setState(current => current && current.revision > next.revision ? current : next)
    }
    const unsubscribe = window.strataWindow.subscribe(receive)
    void window.strataWindow.getState().then(receive).catch(error => {
      window.strata.reportError?.({ scope: 'window', message: String(error) })
    })
    return () => { active = false; unsubscribe() }
  }, [])
  return state
}
