import { useEffect, useLayoutEffect, useRef } from 'react'
import { toastLifetime, type ToastState } from '../toasts'
import { isEscapeClaimed } from '../escape'

interface ToastProps { toast: ToastState | null; onDone(id: number): void }

/**
 * One toast slot. A passing note clears itself; an error stays until the ×,
 * Escape, or a newer error (PRD §6.9). Escape yields to any surface that
 * already claimed the key, so it never closes two things at once.
 */
export function Toast({ toast, onDone }: ToastProps) {
  const current = useRef({ toast, onDone })
  useLayoutEffect(() => { current.current = { toast, onDone } }, [toast, onDone])
  useEffect(() => {
    if (!toast) return
    const lifetime = toastLifetime(toast)
    if (lifetime === null) return
    const timer = window.setTimeout(() => onDone(toast.id), lifetime)
    return () => window.clearTimeout(timer)
  }, [toast, onDone])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const { toast, onDone } = current.current
      if (event.key !== 'Escape' || toast?.tone !== 'error') return
      // Surfaces above the toast claim Escape synchronously; check after they ran.
      window.setTimeout(() => { if (!isEscapeClaimed(event)) onDone(toast.id) }, 0)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  if (!toast) return null
  if (toast.tone === 'error') {
    return (
      <div className="toast toast-error" role="alert" key={toast.id}>
        <i />{toast.message}
        <button type="button" aria-label="Dismiss" onClick={() => onDone(toast.id)}>×</button>
      </div>
    )
  }
  return (
    <div className="toast" role="status" key={toast.id}>
      <i />{toast.message}
      {toast.action && <button type="button" className="toast-action" onClick={() => { toast.action?.run(); onDone(toast.id) }}>{toast.action.label}</button>}
    </div>
  )
}
