import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ComputerRequest, ComputerView } from '../shared/computer'

/** Progress reads local APIs only; costly CLI discovery is reserved for explicit status refreshes. */
export function useComputer() {
  const [view, setView] = useState<ComputerView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const latest = useRef(view)
  useLayoutEffect(() => { latest.current = view }, [view])
  const revision = useRef(0), pending = useRef(false), saving = useRef(false), alive = useRef(true)
  const request = useCallback(async (action: ComputerRequest) => {
    if (saving.current) return
    const previous = latest.current
    saving.current = true; ++revision.current; setBusy(true); setError('')
    if (action.action === 'preferences') setView(current => current ? { ...current, preferences: { ...current.preferences, keepRunning: action.keepRunning, startAtLogin: action.startAtLogin } } : current)
    try {
      const next = await window.strata.computer!(action)
      if (alive.current) setView(next)
      return next
    } catch (error) { if (alive.current) { if (action.action === 'preferences') setView(previous); setError(error instanceof Error ? error.message : String(error)) } }
    finally { saving.current = false; if (alive.current) setBusy(false) }
  }, [])
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const running = view?.job.state === 'running'
  const observe = running || !!view?.connect?.authenticated
  useEffect(() => {
    let current = true
    const refresh = async (progress: boolean) => {
      if (pending.current || saving.current) return
      pending.current = true
      const version = revision.current
      try {
        const next = await window.strata.computer!({ action: progress ? 'progress' : 'status' })
        if (current && !saving.current && revision.current === version) setView(next)
      } catch (error) { if (current && revision.current === version) setError(String(error)) }
      finally { pending.current = false }
    }
    const focus = () => { void refresh(false) }
    void refresh(false); window.addEventListener('focus', focus)
    const timer = observe ? setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(true) }, running ? 500 : 3000) : undefined
    return () => { current = false; clearInterval(timer); window.removeEventListener('focus', focus) }
  }, [running, observe])
  return { view, error, busy, request }
}
