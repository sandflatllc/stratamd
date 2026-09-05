import { EventEmitter } from 'node:events'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { windowController } from '../../src/main/window-controls'
import { windowChrome, windowFrameOptions } from '../../src/platform/window'
import { WindowControls } from '../../src/renderer/components/WindowControls'

describe('desktop window controls', () => {
  it('keeps native traffic lights on macOS, custom controls on Linux, and native framing elsewhere', () => {
    expect(windowFrameOptions('linux')).toEqual({ frame: false })
    expect(windowFrameOptions('darwin')).toMatchObject({ frame: true, titleBarStyle: 'hiddenInset' })
    expect(windowFrameOptions('win32')).toEqual({ frame: true })
    expect(windowChrome('linux')).toBe('custom')
    expect(windowChrome('darwin')).toBe('traffic-lights')
    expect(windowChrome('win32')).toBe('native')
  })

  it('uses window.close, follows external state changes, and removes its subscriptions', () => {
    let maximized = false
    const window = Object.assign(new EventEmitter(), {
      isMaximized: () => maximized, isFullScreen: () => false, isFocused: () => true,
      minimize: vi.fn(), close: vi.fn(), destroy: vi.fn(),
      maximize: vi.fn(() => { maximized = true; window.emit('maximize') }),
      unmaximize: vi.fn(() => { maximized = false; window.emit('unmaximize') })
    })
    const controller = windowController(window as never, 'custom')
    const receive = vi.fn()
    const unsubscribe = controller.subscribe(receive)
    controller.minimize()
    expect(window.minimize).toHaveBeenCalledOnce()
    controller.toggleMaximize()
    expect(receive).toHaveBeenLastCalledWith(expect.objectContaining({ maximized: true, revision: 1 }))
    controller.toggleMaximize()
    expect(receive).toHaveBeenLastCalledWith(expect.objectContaining({ maximized: false, revision: 2 }))
    window.maximize()
    expect(controller.getState()).toMatchObject({ maximized: true, revision: 3 })
    controller.close()
    expect(window.close).toHaveBeenCalledOnce()
    expect(window.destroy).not.toHaveBeenCalled()
    unsubscribe()
    window.emit('blur')
    expect(receive).toHaveBeenCalledTimes(3)
    expect(window.eventNames()).toEqual([])
  })

  it('names the restore action and leaves native and fullscreen controls to the OS', () => {
    const state = { revision: 0, chrome: 'custom' as const, maximized: false, fullscreen: false, focused: true }
    const render = (patch = {}) => renderToStaticMarkup(createElement(WindowControls, { state: { ...state, ...patch }, onAction: vi.fn() }))
    expect(render()).toContain('aria-label="Maximize window"')
    expect(render({ maximized: true })).toContain('aria-label="Restore window"')
    expect(render({ chrome: 'traffic-lights' })).toBe('')
    expect(render({ chrome: 'native' })).toBe('')
    expect(render({ fullscreen: true })).toBe('')
  })
})
