import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { EngineView, TerminalTarget } from '../../shared/contracts'
import { GhosttyTerminalSurface } from '../terminal/ghostty/surface'
import type { GhosttyTheme } from '../terminal/ghostty/core'
import { applyTerminalAttachStreamEvent, EMPTY_TERMINAL_BUFFER_STATE } from '../terminal/buffer'
import { TerminalIcon, XIcon } from '../icons/lucide'
import { hasPrimaryModifier } from '../../shared/primary-modifier'

function terminalTheme(element: HTMLElement): GhosttyTheme {
  const style = getComputedStyle(element)
  const color = (token: string) => {
    const probe = document.createElement('span')
    probe.style.color = style.getPropertyValue(token); element.append(probe)
    const values = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0]
    probe.remove()
    return { r: values[0] ?? 0, g: values[1] ?? 0, b: values[2] ?? 0 }
  }
  return { foreground: color('--text'), background: color('--card'), cursor: color('--text'), selectionBackground: `color-mix(in srgb, ${style.getPropertyValue('--controls-selected')} 40%, transparent)` }
}

export function TerminalDrawer({ target, cwd, engineState, themeKey, onOpenLink, onClose }: {
  target: TerminalTarget | null; cwd: string; engineState: EngineView['state']; themeKey: unknown; onOpenLink(url: string, event: MouseEvent): void; onClose(): void
}) {
  const openLink = useRef(onOpenLink)
  const clickedLink = useRef<string | null>(null)
  useLayoutEffect(() => { openLink.current = onOpenLink }, [onOpenLink])
  const mount = useRef<HTMLDivElement>(null)
  const surface = useRef<GhosttyTerminalSurface | null>(null)
  const [error, setError] = useState('')
  const [label, setLabel] = useState('Shell')
  const [status, setStatus] = useState('Connecting')
  const [retry, setRetry] = useState(0)
  const threadId = target?.threadId
  const terminalId = target?.terminalId
  useEffect(() => {
    const host = mount.current
    if (!host || !threadId || !terminalId || engineState !== 'connected') return
    const attachmentId = crypto.randomUUID()
    const terminal = { threadId, terminalId }
    let active = true
    let attached = false
    let buffer = EMPTY_TERMINAL_BUFFER_STATE
    setError(''); setStatus('Connecting'); setLabel('Shell')
    const fail = (failure: unknown) => { if (active) setError(String(failure)) }
    const stop = window.strata.onTerminalEvent?.(push => {
      if (!active || push.attachmentId !== attachmentId) return
      const event = push.event
      const eventTarget = event.type === 'snapshot' ? event.snapshot : event
      if (eventTarget.threadId !== threadId || eventTarget.terminalId !== terminalId) return
      buffer = applyTerminalAttachStreamEvent(buffer, event)
      setStatus(buffer.status); setError(buffer.error ?? '')
      if (event.type === 'snapshot' || event.type === 'restarted') { setLabel(event.snapshot.label); surface.current?.resetAndWrite(buffer.buffer) }
      else if (event.type === 'output') surface.current?.write(event.data)
      else if (event.type === 'cleared') surface.current?.resetAndWrite('')
      else if (event.type === 'activity') setLabel(event.label)
    })
    void GhosttyTerminalSurface.create(host, {
      theme: terminalTheme(host),
      onData: data => { if (active && attached) void window.strata.writeEngineTerminal({ ...terminal, data }).catch(fail) },
      onResize: (cols, rows) => { if (active && attached) void window.strata.resizeEngineTerminal({ ...terminal, cols, rows }).catch(fail) },
      onSelectionChange: () => undefined,
      beforeKey: event => !(hasPrimaryModifier(event) && event.code === 'Backquote'),
      // Ghostty recognizes links on pointerup; the following click supplies
      // the browser's native double-click count to the shared picker.
      onLinkActivate: text => { clickedLink.current = text },
    }).then(async created => {
      if (!active) { created.dispose(); return }
      surface.current = created
      created.resetAndWrite(buffer.buffer); created.fit(); created.focus()
      attached = true
      await window.strata.attachEngineTerminal({ ...terminal, attachmentId, cwd, cols: created.cols, rows: created.rows })
    }).catch(fail)
    return () => {
      active = false; stop?.()
      void window.strata.detachEngineTerminal(attachmentId).catch(() => undefined)
      surface.current?.dispose(); surface.current = null
    }
  }, [threadId, terminalId, cwd, engineState, retry])
  useEffect(() => { if (mount.current) surface.current?.setTheme(terminalTheme(mount.current)) }, [themeKey])
  const unavailable = !target ? 'Add a project to open its terminal.' : engineState !== 'connected' ? 'Connect the engine to use its terminal.' : ''
  return <section className="island terminal-drawer" aria-label="Terminal" onPointerDownCapture={() => { clickedLink.current = null }} onClick={event => {
    const url = clickedLink.current
    clickedLink.current = null
    if (url) openLink.current(url, event.nativeEvent)
  }}>
    <header><TerminalIcon /><strong>Terminal</strong><span>{label}</span><span className="terminal-cwd" title={cwd}>{cwd}</span><span className="terminal-status">{status}</span><button type="button" className="icon-button" aria-label="Close terminal" onClick={onClose}><XIcon /></button></header>
    {(error || unavailable) && <div className="terminal-notice" role={error ? 'alert' : 'status'}>{error || unavailable}{error && <button type="button" onClick={() => setRetry(value => value + 1)}>Reconnect terminal</button>}</div>}
    <div className="terminal-surface" ref={mount} />
  </section>
}
