import { useEffect, useState } from 'react'

/**
 * The current time, refreshed on an interval, so relative copy ("saved just
 * now", "attached 3 minutes ago") moves on without any other render.
 */
export function useClock(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}
