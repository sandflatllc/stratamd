// Escape closes one surface at a time (PRD §6.9). A surface that handles the
// key marks the event; every surface below it checks the mark and stays put.
// `defaultPrevented` cannot serve here: ProseMirror prevents Escape's default
// whenever the editor has focus, without meaning anything by it.

const claimed = new WeakSet<Event>()

export function claimEscape(event: Event): void {
  claimed.add(event)
  event.preventDefault()
}

export function isEscapeClaimed(event: Event): boolean {
  return claimed.has(event)
}
