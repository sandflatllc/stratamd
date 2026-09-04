import { useCallback } from 'react'

interface ResizerProps {
  axis: 'horizontal' | 'vertical'
  label: string
  value: number
  min: number
  max: number
  invert?: boolean
  expanded?: boolean
  onToggle?(): void
  onChange(value: number): void
  onCommit(value: number): void
}

export function Resizer({ axis, label, value, min, max, invert = false, expanded, onToggle, onChange, onCommit }: ResizerProps) {
  const start = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    if (expanded === false) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const origin = axis === 'vertical' ? event.clientX : event.clientY
    let latest = value
    const move = (next: PointerEvent) => {
      const point = axis === 'vertical' ? next.clientX : next.clientY
      const delta = (point - origin) * (invert ? -1 : 1)
      latest = Math.max(min, Math.min(max, Math.round(value + delta)))
      onChange(latest)
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      onCommit(latest)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
  }, [axis, expanded, invert, max, min, onChange, onCommit, value])

  return (
    <button
      type="button"
      className={`resizer resizer-${axis}`}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-expanded={expanded}
      title={onToggle ? `Double-click to ${expanded ? 'collapse' : 'expand'}. Enter or Space also toggles.` : undefined}
      onDoubleClick={onToggle}
      onKeyDown={onToggle ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onToggle()
        }
      } : undefined}
      onPointerDown={start}
    ><span /></button>
  )
}
