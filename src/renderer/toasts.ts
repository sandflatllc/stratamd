// Toast policy (PRD §6.9). A success is a passing note that clears itself; an
// error is a fact the user has to see, so it stays until they dismiss it or a
// newer error replaces it, and a passing note never paints over it.

export type ToastTone = 'info' | 'error'

export interface ToastAction {
  label: string
  run(): void
}

export interface ToastState {
  id: number
  message: string
  tone: ToastTone
  /** One optional button, such as Show on an agent-activity note. */
  action?: ToastAction
}

export const INFO_TOAST_MS = 2800

let nextToastId = 1

/** The toast to show after `incoming` arrives while `current` is up; null keeps nothing. */
export function nextToast(current: ToastState | null, incoming: { message: string; tone: ToastTone; action?: ToastAction }): ToastState | null {
  if (!incoming.message) return current
  if (incoming.tone === 'info' && current?.tone === 'error') return current
  return { id: nextToastId++, message: incoming.message, tone: incoming.tone, ...(incoming.action ? { action: incoming.action } : {}) }
}

/** How long a toast stays on its own; null means until dismissed. */
export function toastLifetime(toast: ToastState): number | null {
  if (toast.tone === 'error') return null
  // A note with a button stays long enough to reach for it.
  return toast.action ? INFO_TOAST_MS * 3 : INFO_TOAST_MS
}
