import { useLayoutEffect, useRef, type RefObject } from 'react'

// An explicit tabindex="-1" opts an element out of the tab ring (the composer's
// pointer-only resize handle); the trap must not wrap onto it.
const FOCUSABLE = [
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'a[href]:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true')
}

export function useDialogFocus<T extends HTMLElement>(dialogRef: RefObject<T | null>, onEscape: (() => void) | undefined): void {
  const escapeRef = useRef(onEscape)
  escapeRef.current = onEscape

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const initialFocus = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]') ?? focusableElements(dialog)[0] ?? dialog
    initialFocus.focus({ preventScroll: true })

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        escapeRef.current?.()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = focusableElements(dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus({ preventScroll: true })
        return
      }
      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }

    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('keydown', handleKey, true)
      if (priorFocus?.isConnected) priorFocus.focus({ preventScroll: true })
    }
  }, [dialogRef])
}
