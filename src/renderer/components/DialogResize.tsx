import { useRef } from 'react'
import './utility-dialogs.css'

/** The dialogs stay centered, so each dragged edge moves half the size change. */
export function DialogResize({ name }: { name: string }) {
  const drag = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const resize = (button: HTMLElement, width: number, height: number) => {
    const dialog = button.closest<HTMLElement>('[role="dialog"]')
    if (!dialog) return
    dialog.style.width = `${Math.min(window.innerWidth - 40, Math.max(560, width))}px`
    dialog.style.height = `${Math.min(window.innerHeight - 40, Math.max(320, height))}px`
  }
  return <button type="button" className="utility-dialog-resize" aria-label={`Resize ${name}`} title="Drag to resize. Arrow keys change width and height." onPointerDown={event => {
    event.preventDefault()
    const bounds = event.currentTarget.closest('[role="dialog"]')!.getBoundingClientRect()
    drag.current = { x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height }
    event.currentTarget.setPointerCapture(event.pointerId)
  }} onPointerMove={event => {
    const start = drag.current
    if (start) resize(event.currentTarget, start.width + 2 * (event.clientX - start.x), start.height + 2 * (event.clientY - start.y))
  }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const bounds = event.currentTarget.closest('[role="dialog"]')!.getBoundingClientRect()
    const step = event.shiftKey ? 40 : 10
    resize(event.currentTarget, bounds.width + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), bounds.height + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0))
  }}>◢</button>
}
