import type { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import type { WindowState } from '../shared/contracts'
import { windowChrome } from '../platform/window'

/** Bound to one window; never accepts renderer-supplied window IDs. */
export interface WindowController {
  getState(): WindowState
  subscribe(listener: (state: WindowState) => void): () => void
  minimize(): void
  toggleMaximize(): void
  close(): void
}

export function windowController(window: BrowserWindow, chrome = windowChrome()): WindowController {
  let revision = 0
  const getState = (): WindowState => ({
    revision,
    chrome,
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
    focused: window.isFocused()
  })
  return {
    getState,
    subscribe(listener) {
      const publish = () => { revision += 1; listener(getState()) }
      const events = ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur'] as const
      const emitter: Pick<EventEmitter, 'on' | 'removeListener'> = window
      for (const event of events) emitter.on(event, publish)
      return () => { for (const event of events) emitter.removeListener(event, publish) }
    },
    minimize: () => window.minimize(),
    toggleMaximize: () => { if (window.isMaximized()) window.unmaximize(); else window.maximize() },
    close: () => window.close()
  }
}
